#!/usr/bin/env bun
/**
 * Ingest Hermes Agent docs (llms-full.txt) → local Qdrant `hermes-docs` collection.
 *
 * Fetches https://hermes-agent.nousresearch.com/docs/llms-full.txt fresh each run,
 * splits on <!-- source: ... --> page boundaries, chunks, embeds with
 * text-embedding-3-small (1536d), and upserts to the hermes-docs collection.
 *
 * Pattern mirrors zouroboros/packages/swarm/scripts/qdrant-indexer.ts.
 *
 * Run:
 *   bun /home/workspace/Skills/zo-memory-system/scripts/ingest-hermes-docs.ts            (append/update existing)
 *   bun /home/workspace/Skills/zo-memory-system/scripts/ingest-hermes-docs.ts --recreate (drop + rebuild)
 *
 * Supply-chain integrity (P1-1): the remote doc is SHA-256 verified against a
 * durable pin before it is allowed to touch the collection. A changed hash means
 * ingest REFUSES (the existing collection is left intact and the last-good cached
 * copy is preserved) until a human reviews the diff and re-runs with --update-pin.
 *   --update-pin                    accept the current upstream content and re-pin
 *   HERMES_DOCS_AUTO_ACCEPT=1       (env) auto-re-pin on every change (NOT recommended)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Self-heal OPENAI key from /root/.zo_secrets when invoked under `env -i`.
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

const { embeddings: mcEmbeddings } = await import(
  "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts"
);

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "hermes-docs";
const VECTOR_SIZE = 1536;
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;
const DOCS_URL = "https://hermes-agent.nousresearch.com/docs/llms-full.txt";
const CACHE_PATH = "/dev/shm/hermes-llms-full.txt";
const CANONICAL_BASE = "https://hermes-agent.nousresearch.com/docs";

// Durable supply-chain state (gitignored): trust pin + last-good copy survive
// sandbox restarts, unlike the /dev/shm working cache.
const STATE_DIR = "/home/workspace/Skills/zo-memory-system/scripts/.hermes-state";
const PIN_PATH = `${STATE_DIR}/pin.sha256`;
const LAST_GOOD_PATH = `${STATE_DIR}/last-good.txt`;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}
async function qReq(method: string, path: string, body?: any) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: qHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function ensureCollection(name: string, recreate: boolean) {
  const exists = await fetch(`${QDRANT_URL}/collections/${name}`, { headers: qHeaders() });
  if (exists.ok) {
    if (recreate) {
      console.log(`  collection '${name}' exists, recreating...`);
      await qReq("DELETE", `/collections/${name}`);
    } else {
      console.log(`  collection '${name}' exists, reusing.`);
      return;
    }
  }
  await qReq("PUT", `/collections/${name}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    on_disk_payload: true,
  });
  console.log(`  collection '${name}' ready.`);
}

function chunkText(text: string, chars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chars) return [text];
  const advance = Math.max(1, chars - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += advance) chunks.push(text.slice(i, i + chars));
  return chunks;
}

const CTRL_RE = new RegExp(
  "[" +
    "\\u0000-\\u0008" +
    "\\u000B\\u000C" +
    "\\u000E-\\u001F" +
    "\\uFEFF" +
    "]",
  "g",
);
function sanitize(s: string): string {
  let out = s.replace(CTRL_RE, "");
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return out;
}
function sanitizePoint(p: { id: number; vector: number[]; payload: any }) {
  const payload = { ...p.payload };
  for (const k of Object.keys(payload)) if (typeof payload[k] === "string") payload[k] = sanitize(payload[k]);
  return { ...p, payload };
}
async function upsert(points: { id: number; vector: number[]; payload: any }[]) {
  if (points.length === 0) return;
  const cleaned = points.map(sanitizePoint);
  try {
    await qReq("PUT", `/collections/${COLLECTION}/points?wait=true`, { points: cleaned });
  } catch {
    let kept = 0;
    for (const p of cleaned) {
      try {
        await qReq("PUT", `/collections/${COLLECTION}/points?wait=true`, { points: [p] });
        kept++;
      } catch (err) {
        console.error(`\n  drop id=${p.id} src=${p.payload.source}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    if (kept < cleaned.length) process.stdout.write(`(${kept}/${cleaned.length})`);
  }
}

function sourceToUrl(sourcePath: string): string {
  let p = sourcePath.replace(/^website\/docs\//, "").replace(/\.md$/, "");
  if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
  return `${CANONICAL_BASE}/${p}`;
}

function parseSections(raw: string): { source: string; body: string }[] {
  const out: { source: string; body: string }[] = [];
  const re = /<!--\s*source:\s*([^\s>]+)\s*-->/g;
  const marks: { source: string; index: number; mEnd: number }[] = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ source: m[1], index: m.index, mEnd: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].mEnd;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    const body = raw.slice(start, end).trim();
    if (body.length >= 40) out.push({ source: marks[i].source, body });
  }
  return out;
}

async function fetchDocs(opts: { updatePin: boolean; autoAccept: boolean }): Promise<string> {
  console.log(`  fetching ${DOCS_URL}`);
  let text: string;
  try {
    const r = await fetch(DOCS_URL);
    if (!r.ok) throw new Error(`fetch docs: ${r.status}`);
    text = await r.text();
  } catch (e) {
    // Network/upstream failure: fall back to the last-good copy if we have one,
    // rather than failing the run or (worse) ingesting nothing.
    if (existsSync(LAST_GOOD_PATH)) {
      console.warn(`  ⚠ fetch failed (${(e as Error).message}) — using last-good cached copy`);
      const cached = readFileSync(LAST_GOOD_PATH, "utf8");
      writeFileSync(CACHE_PATH, cached);
      return cached;
    }
    throw e;
  }

  const digest = sha256(text);
  const pinned = existsSync(PIN_PATH) ? readFileSync(PIN_PATH, "utf8").trim() : "";
  mkdirSync(STATE_DIR, { recursive: true });

  if (!pinned) {
    // Trust-on-first-use: establish the pin so future drift is detectable.
    writeFileSync(PIN_PATH, digest + "\n");
    writeFileSync(LAST_GOOD_PATH, text);
    console.log(`  no pin found — established TOFU pin sha256:${digest.slice(0, 16)}…`);
  } else if (digest === pinned) {
    console.log(`  integrity OK — sha256:${digest.slice(0, 16)}… matches pin`);
    writeFileSync(LAST_GOOD_PATH, text);
  } else if (opts.updatePin || opts.autoAccept) {
    writeFileSync(PIN_PATH, digest + "\n");
    writeFileSync(LAST_GOOD_PATH, text);
    console.warn(
      `  ⚠ content changed; pin UPDATED to sha256:${digest.slice(0, 16)}… ` +
        `(${opts.updatePin ? "--update-pin" : "HERMES_DOCS_AUTO_ACCEPT=1"})`,
    );
  } else {
    console.error(`  ✗ INTEGRITY MISMATCH`);
    console.error(`    fetched : sha256:${digest}`);
    console.error(`    pinned  : sha256:${pinned}`);
    console.error(`    Refusing to ingest — the existing collection and last-good copy are left intact.`);
    console.error(`    If this change is expected, review the diff then re-run with --update-pin:`);
    console.error(`      diff ${LAST_GOOD_PATH} <(curl -s ${DOCS_URL})`);
    throw new Error("hermes-docs integrity check failed (hash mismatch) — ingest aborted");
  }

  writeFileSync(CACHE_PATH, text);
  console.log(`  fetched ${text.length.toLocaleString()} chars → ${CACHE_PATH}`);
  return text;
}

let nextId = 1;
const newId = () => nextId++;

async function main() {
  // Default to --recreate semantics when invoked without explicit flag, since the
  // collection uses sequential integer IDs and we want a fresh snapshot each run.
  const recreate = !process.argv.includes("--no-recreate");
  const updatePin = process.argv.includes("--update-pin");
  const autoAccept = process.env.HERMES_DOCS_AUTO_ACCEPT === "1";
  console.log(`Hermes docs → Qdrant ${QDRANT_URL} collection=${COLLECTION} recreate=${recreate}`);
  const start = Date.now();

  // Integrity gate runs BEFORE ensureCollection so a hash mismatch aborts the run
  // without ever deleting/recreating the live collection.
  const raw = await fetchDocs({ updatePin, autoAccept });
  await ensureCollection(COLLECTION, recreate);

  const sections = parseSections(raw);
  console.log(`  parsed ${sections.length} sections from llms-full.txt`);

  let total = 0;
  let batch: { id: number; vector: number[]; payload: any }[] = [];
  for (const sec of sections) {
    const url = sourceToUrl(sec.source);
    const chunks = chunkText(sec.body);
    for (let i = 0; i < chunks.length; i++) {
      try {
        const result = await mcEmbeddings(chunks[i]);
        if (!result.embedding?.length) throw new Error("empty embedding");
        batch.push({
          id: newId(),
          vector: result.embedding,
          payload: {
            collection: COLLECTION,
            source: sec.source,
            url,
            chunk_index: i,
            chunk_total: chunks.length,
            content: chunks[i],
            doc: "hermes-agent",
          },
        });
        total++;
        if (batch.length >= 32) {
          await upsert(batch);
          batch = [];
          process.stdout.write(".");
        }
      } catch (e) {
        console.error(`\n  skip ${sec.source}#${i}: ${(e as Error).message}`);
      }
    }
  }
  if (batch.length) await upsert(batch);
  console.log(
    `\n  indexed ${total} chunks across ${sections.length} sections in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
