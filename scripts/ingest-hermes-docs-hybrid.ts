#!/usr/bin/env bun
/**
 * Hybrid (dense + sparse BM25) ingest for Hermes docs.
 *
 * Differs from ingest-hermes-docs.ts in three ways:
 *  1. Collection created with NAMED vectors: `dense` (1536d cosine) +
 *     `sparse` (sparse vector with modifier: "idf").
 *  2. Each chunk is upserted with both vectors at once.
 *  3. Query-time hybrid search uses Qdrant's prefetch+fusion API in
 *     qdrant-rag-mcp.ts (RRF combines dense+sparse rankings).
 *
 * Run:
 *   bun /home/workspace/Skills/zo-memory-system/scripts/ingest-hermes-docs-hybrid.ts            (recreate)
 *   bun /home/workspace/Skills/zo-memory-system/scripts/ingest-hermes-docs-hybrid.ts --no-recreate
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
const COLLECTION = "hermes-docs";
const DENSE_DIM = 1536;
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;
const DOCS_URL = "https://hermes-agent.nousresearch.com/docs/llms-full.txt";
const CACHE_PATH = "/dev/shm/hermes-llms-full.txt";
const CANONICAL_BASE = "https://hermes-agent.nousresearch.com/docs";

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

async function ensureHybridCollection(name: string, recreate: boolean) {
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

async function upsert(points: any[]) {
  if (points.length === 0) return;
  const cleaned = points.map((p) => {
    const payload = { ...p.payload };
    for (const k of Object.keys(payload)) if (typeof payload[k] === "string") payload[k] = sanitize(payload[k]);
    return { ...p, payload };
  });
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
  while ((m = re.exec(raw)) !== null) marks.push({ source: m[1], index: m.index, mEnd: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].mEnd;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    const body = raw.slice(start, end).trim();
    if (body.length >= 40) out.push({ source: marks[i].source, body });
  }
  return out;
}

async function fetchDocs(): Promise<string> {
  console.log(`  fetching ${DOCS_URL}`);
  const r = await fetch(DOCS_URL);
  if (!r.ok) throw new Error(`fetch docs: ${r.status}`);
  const text = await r.text();
  writeFileSync(CACHE_PATH, text);
  console.log(`  fetched ${text.length.toLocaleString()} chars → ${CACHE_PATH}`);
  return text;
}

let nextId = 1;
const newId = () => nextId++;

async function main() {
  const recreate = !process.argv.includes("--no-recreate");
  console.log(`Hermes docs HYBRID → Qdrant ${QDRANT_URL} collection=${COLLECTION} recreate=${recreate}`);
  const start = Date.now();

  const raw = await fetchDocs();
  await ensureHybridCollection(COLLECTION, recreate);

  const sections = parseSections(raw);
  console.log(`  parsed ${sections.length} sections from llms-full.txt`);

  let total = 0;
  let batch: any[] = [];
  for (const sec of sections) {
    const url = sourceToUrl(sec.source);
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
  console.log(`\n  indexed ${total} chunks across ${sections.length} sections in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
