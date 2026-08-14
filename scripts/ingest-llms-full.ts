#!/usr/bin/env bun
/**
 * Generic hybrid (dense + sparse BM25) ingest for any `llms-full.txt` docs corpus.
 *
 * Generalizes ingest-hermes-docs-hybrid.ts, which is hardcoded to one vendor and
 * one section-marker format. Two marker formats are auto-detected:
 *
 *   comment  `<!-- source: path/to/page.md -->`   (Docusaurus / hermes-agent)
 *   heading  `# Page Title` + `Source: https://…`  (Mintlify / anam.ai)
 *
 * Collections are created with NAMED vectors (`dense` 1536d cosine + `sparse`
 * BM25/IDF), which is what qdrant-rag-mcp.ts probes at query time to enable
 * hybrid RRF fusion. Dense-only collections silently fall back to dense search.
 *
 * Run:
 *   bun ingest-llms-full.ts --url https://anam.ai/docs/llms-full.txt \
 *     --collection anam-docs --doc anam --base https://anam.ai/docs
 *   bun ingest-llms-full.ts --preset anam
 *   bun ingest-llms-full.ts --preset anam --no-recreate
 */
import { readFileSync, writeFileSync } from "node:fs";

if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

const { embeddings: mcEmbeddings } = await import("./model-client");
const { buildSparseVector } = await import("./rag-pipeline");

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const DENSE_DIM = 1536;
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

interface Preset {
  url: string;
  collection: string;
  doc: string;
  base: string;
}

const PRESETS: Record<string, Preset> = {
  anam: {
    url: "https://anam.ai/docs/llms-full.txt",
    collection: "anam-docs",
    doc: "anam",
    base: "https://anam.ai/docs",
  },
  hermes: {
    url: "https://hermes-agent.nousresearch.com/docs/llms-full.txt",
    collection: "hermes-docs",
    doc: "hermes-agent",
    base: "https://hermes-agent.nousresearch.com/docs",
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveConfig(): Preset {
  const preset = arg("preset");
  const base = preset ? PRESETS[preset] : undefined;
  if (preset && !base) {
    throw new Error(`unknown preset '${preset}' (have: ${Object.keys(PRESETS).join(", ")})`);
  }
  const cfg = {
    url: arg("url") || base?.url,
    collection: arg("collection") || base?.collection,
    doc: arg("doc") || base?.doc,
    base: arg("base") || base?.base,
  };
  for (const [k, v] of Object.entries(cfg)) {
    if (!v) throw new Error(`missing --${k} (or supply --preset)`);
  }
  return cfg as Preset;
}

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

async function qReq<T = unknown>(method: string, path: string, body?: any): Promise<T> {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: qHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function ensureHybridCollection(name: string, recreate: boolean) {
  const exists = await fetch(`${QDRANT_URL}/collections/${name}`, { headers: qHeaders() });
  if (exists.ok) {
    if (!recreate) {
      console.log(`  collection '${name}' exists, reusing.`);
      return;
    }
    console.log(`  collection '${name}' exists, recreating...`);
    await qReq("DELETE", `/collections/${name}`);
  }
  await qReq("PUT", `/collections/${name}`, {
    vectors: { dense: { size: DENSE_DIM, distance: "Cosine" } },
    sparse_vectors: { sparse: { modifier: "idf" } },
    on_disk_payload: true,
  });
  console.log(`  collection '${name}' ready (dense=${DENSE_DIM}d cosine + sparse=BM25/IDF).`);
}

function chunkText(text: string, chars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chars) return [text];
  const advance = Math.max(1, chars - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += advance) chunks.push(text.slice(i, i + chars));
  return chunks;
}

const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFEFF]", "g");
function sanitize(s: string): string {
  let out = s.replace(CTRL_RE, "");
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return out;
}

async function upsert(collection: string, points: any[]) {
  if (points.length === 0) return;
  const cleaned = points.map((p) => {
    const payload = { ...p.payload };
    for (const k of Object.keys(payload)) {
      if (typeof payload[k] === "string") payload[k] = sanitize(payload[k]);
    }
    return { ...p, payload };
  });
  try {
    await qReq("PUT", `/collections/${collection}/points?wait=true`, { points: cleaned });
  } catch {
    let kept = 0;
    for (const p of cleaned) {
      try {
        await qReq("PUT", `/collections/${collection}/points?wait=true`, { points: [p] });
        kept++;
      } catch (err) {
        console.error(`\n  drop id=${p.id} src=${p.payload.source}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    if (kept < cleaned.length) process.stdout.write(`(${kept}/${cleaned.length})`);
  }
}

interface Section {
  source: string;
  title: string;
  url: string;
  body: string;
}

function parseCommentMarkers(raw: string, base: string): Section[] {
  const out: Section[] = [];
  const re = /<!--\s*source:\s*([^\s>]+)\s*-->/g;
  const marks: { source: string; index: number; mEnd: number }[] = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ source: m[1], index: m.index, mEnd: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const body = raw.slice(marks[i].mEnd, i + 1 < marks.length ? marks[i + 1].index : raw.length).trim();
    if (body.length < 40) continue;
    let p = marks[i].source.replace(/^website\/docs\//, "").replace(/\.md$/, "");
    if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
    out.push({ source: marks[i].source, title: p, url: `${base}/${p}`, body });
  }
  return out;
}

function parseHeadingMarkers(raw: string): Section[] {
  const out: Section[] = [];
  const re = /^#\s+(.+)\n+Source:\s+(\S+)\s*$/gm;
  const marks: { title: string; url: string; index: number; mEnd: number }[] = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ title: m[1].trim(), url: m[2].trim(), index: m.index, mEnd: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const body = raw.slice(marks[i].mEnd, i + 1 < marks.length ? marks[i + 1].index : raw.length).trim();
    if (body.length < 40) continue;
    const source = marks[i].url.replace(/^https?:\/\/[^/]+\//, "");
    out.push({ source, title: marks[i].title, url: marks[i].url, body: `${marks[i].title}\n\n${body}` });
  }
  return out;
}

function parseSections(raw: string, base: string): { sections: Section[]; format: string } {
  const comment = parseCommentMarkers(raw, base);
  const heading = parseHeadingMarkers(raw);
  if (comment.length >= heading.length && comment.length > 0) {
    return { sections: comment, format: "comment" };
  }
  if (heading.length > 0) return { sections: heading, format: "heading" };
  throw new Error("no section markers found (expected '<!-- source: -->' or '# Title' + 'Source:')");
}

async function fetchDocs(url: string, cachePath: string): Promise<string> {
  console.log(`  fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch docs: ${r.status}`);
  const text = await r.text();
  writeFileSync(cachePath, text);
  console.log(`  fetched ${text.length.toLocaleString()} chars -> ${cachePath}`);
  return text;
}

let nextId = 1;
const newId = () => nextId++;

async function main() {
  const cfg = resolveConfig();
  const recreate = !process.argv.includes("--no-recreate");
  const cachePath = arg("cache") || `/dev/shm/${cfg.collection}-llms-full.txt`;
  console.log(`llms-full HYBRID -> Qdrant ${QDRANT_URL} collection=${cfg.collection} recreate=${recreate}`);
  const start = Date.now();

  const raw = await fetchDocs(cfg.url, cachePath);
  await ensureHybridCollection(cfg.collection, recreate);

  const { sections, format } = parseSections(raw, cfg.base);
  console.log(`  parsed ${sections.length} sections from llms-full.txt (format=${format})`);

  let total = 0;
  let failed = 0;
  let batch: any[] = [];
  for (const sec of sections) {
    const chunks = chunkText(sec.body);
    for (let i = 0; i < chunks.length; i++) {
      try {
        const result = await mcEmbeddings(chunks[i]);
        if (!result.embedding?.length) throw new Error("empty embedding");
        const sparse = buildSparseVector(chunks[i]);
        batch.push({
          id: newId(),
          vector: {
            dense: result.embedding,
            sparse: { indices: sparse.indices, values: sparse.values },
          },
          payload: {
            collection: cfg.collection,
            source: sec.source,
            title: sec.title,
            url: sec.url,
            chunk_index: i,
            chunk_total: chunks.length,
            content: chunks[i],
            doc: cfg.doc,
          },
        });
        total++;
        if (batch.length >= 32) {
          await upsert(cfg.collection, batch);
          batch = [];
          process.stdout.write(".");
        }
      } catch (e) {
        failed++;
        console.error(`\n  skip ${sec.source}#${i}: ${(e as Error).message}`);
      }
    }
  }
  if (batch.length) await upsert(cfg.collection, batch);

  const info = await qReq<{ result?: { points_count?: number; status?: string } }>(
    "GET",
    `/collections/${cfg.collection}`,
  );
  const count = info?.result?.points_count ?? "?";
  console.log(
    `\n  indexed ${total} chunks across ${sections.length} sections in ${((Date.now() - start) / 1000).toFixed(1)}s`
  );
  console.log(`  qdrant points_count=${count} status=${info?.result?.status} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
