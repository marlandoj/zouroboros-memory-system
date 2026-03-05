#!/usr/bin/env bun
/**
 * zo-memory-system v2 — Hybrid SQLite + Vector Search
 * 
 * Enhancements from QMD research:
 * - Vector embeddings (nomic-embed-text via Ollama)
 * - HyDE query expansion (optional)
 * - RRF fusion (BM25 + vectors)
 * - Composite scoring with decay awareness
 * 
 * Backward compatible with v1 facts DB.
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { computeGraphBoost, findGraphNeighbors } from "./graph-boost";

// --- Configuration ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "nomic-embed-text";
const HYDE_MODEL = process.env.ZO_HYDE_MODEL || "qwen2.5:1.5b";

// Decay class TTLs in seconds
const TTL_DEFAULTS: Record<string, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

type DecayClass = "permanent" | "stable" | "active" | "session" | "checkpoint";
type Category = "preference" | "fact" | "decision" | "convention" | "other" | "reference" | "project";

interface MemoryEntry {
  id: string;
  persona: string;
  entity: string;
  key: string | null;
  value: string;
  text: string;
  category: Category;
  decayClass: DecayClass;
  importance: number;
  source: string;
  createdAt: number;
  expiresAt: number | null;
  lastAccessed: number;
  confidence: number;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

// --- Database Setup ---
let db: Database;
let dbInitialized = false;

async function initDb(): Promise<Database> {
  if (dbInitialized && db) return db;
  
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  
  // Ensure v2 schema (add embeddings table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT '${EMBEDDING_MODEL}',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
    CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);
  `);
  
  dbInitialized = true;
  return db;
}

// --- Embedding Service ---
async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text.slice(0, 8000), // Truncate if too long
      }),
    });
    
    if (!response.ok) {
      console.warn(`Ollama error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return data.embedding;
  } catch (err) {
    console.warn(`Embedding failed: ${err}`);
    return null;
  }
}

async function hydeExpand(query: string): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HYDE_MODEL,
        prompt: `Query: "${query}"\n\nHypothetical relevant keywords and context (2-3 sentences):`,
        stream: false,
        options: {
          num_predict: 80,
          temperature: 0.3,
        }
      }),
    });
    
    if (!response.ok) return [query];
    
    const data = await response.json();
    const expanded = data.response?.trim();
    
    if (expanded && expanded.length > 10) {
      return [query, expanded];
    }
    return [query];
  } catch {
    return [query];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Store with Embedding ---
async function storeWithEmbedding(entry: Omit<MemoryEntry, "id" | "createdAt" | "expiresAt" | "lastAccessed">): Promise<MemoryEntry | null> {
  const db = await initDb();
  const id = randomUUID();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  
  const decayClass = entry.decayClass || "stable";
  const expiresAt = TTL_DEFAULTS[decayClass] ? nowSec + TTL_DEFAULTS[decayClass]! : null;
  
  // Insert fact
  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, 
                       importance, source, created_at, expires_at, last_accessed, confidence, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.persona,
    entry.entity,
    entry.key,
    entry.value,
    entry.text || `${entry.entity} ${entry.key || ""}: ${entry.value}`,
    entry.category,
    decayClass,
    entry.importance,
    entry.source,
    now,
    expiresAt,
    nowSec,
    entry.confidence,
    entry.metadata ? JSON.stringify(entry.metadata) : null
  );
  
  // Generate and store embedding
  const textToEmbed = entry.text || `${entry.entity} ${entry.key || ""}: ${entry.value}`;
  const embedding = await getEmbedding(textToEmbed);
  
  if (embedding) {
    db.prepare(`
      INSERT INTO fact_embeddings (fact_id, embedding, model)
      VALUES (?, ?, ?)
    `).run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
  }
  
  return {
    ...entry,
    id,
    createdAt: now,
    expiresAt,
    lastAccessed: nowSec,
  };
}

// --- Hybrid Search ---
async function hybridSearch(
  query: string,
  options: { persona?: string; limit?: number; useHyde?: boolean } = {}
): Promise<Array<{ entry: MemoryEntry; score: number; sources: string[] }>> {
  const db = await initDb();
  const { persona, limit = 10, useHyde = true } = options;
  const nowSec = Math.floor(Date.now() / 1000);

  // PARALLEL: Run FTS for original query + HyDE + embedding simultaneously
  const [ftsBaseResults, queryVariants, queryEmbedding] = await Promise.all([
    // FTS for original query (fast, always needed)
    (async () => {
      const safeQuery = query
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .map((w) => `"${w}"`)
        .join(" OR ");
      
      if (!safeQuery) return [];
      
      return db.prepare(`
        SELECT f.*, rank
        FROM facts f
        JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > ?)
          ${persona ? "AND f.persona = ?" : ""}
        ORDER BY rank
        LIMIT ${limit * 2}
      `).all(...[safeQuery, nowSec, ...(persona ? [persona] : [])]) as Array<Record<string, unknown>>;
    })(),
    // HyDE expansion (slow, runs in parallel)
    useHyde ? hydeExpand(query) : Promise.resolve([query]),
    // Query embedding (runs in parallel)
    getEmbedding(query),
  ]);

  // Collect FTS results
  const ftsResults = new Map<string, { entry: MemoryEntry; rank: number; source: string }>();
  
  for (const row of ftsBaseResults) {
    const id = row.id as string;
    ftsResults.set(id, {
      entry: rowToEntry(row),
      rank: row.rank as number,
      source: `fts:${query.slice(0, 30)}`,
    });
  }

  // If HyDE expanded the query, run FTS for expanded variant (after parallel phase)
  if (queryVariants.length > 1) {
    const hydeQuery = queryVariants[1];
    const safeHydeQuery = hydeQuery
      .replace(/['"]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"`)
      .join(" OR ");
    
    if (safeHydeQuery) {
      const hydeRows = db.prepare(`
        SELECT f.*, rank
        FROM facts f
        JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > ?)
          ${persona ? "AND f.persona = ?" : ""}
        ORDER BY rank
        LIMIT ${limit}
      `).all(...[safeHydeQuery, nowSec, ...(persona ? [persona] : [])]) as Array<Record<string, unknown>>;
      
      for (const row of hydeRows) {
        const id = row.id as string;
        if (!ftsResults.has(id)) {
          ftsResults.set(id, {
            entry: rowToEntry(row),
            rank: row.rank as number,
            source: `fts:hyde`,
          });
        }
      }
    }
  }
  
  // Get vector results
  const vectorResults = new Map<string, { entry: MemoryEntry; similarity: number }>();
  
  if (queryEmbedding) {
    // Get all embeddings and compute similarity
    const embeddings = db.prepare(`
      SELECT fe.fact_id, fe.embedding
      FROM fact_embeddings fe
      JOIN facts f ON fe.fact_id = f.id
      WHERE (f.expires_at IS NULL OR f.expires_at > ?)
        ${persona ? "AND f.persona = ?" : ""}
    `).all(...[nowSec, ...(persona ? [persona] : [])]) as Array<{ fact_id: string; embedding: Buffer }>;
    
    for (const row of embeddings) {
      const embedding = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4));
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      
      if (similarity > 0.5) { // Threshold
        const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(row.fact_id) as Record<string, unknown>;
        if (fact) {
          vectorResults.set(row.fact_id, {
            entry: rowToEntry(fact),
            similarity,
          });
        }
      }
    }
  }
  
  // RRF Fusion
  const scores = new Map<string, { entry: MemoryEntry; ftsRank?: number; vecScore?: number; sources: string[] }>();
  
  const k = 60;
  
  // Add FTS scores
  let ftsPos = 1;
  for (const [id, result] of Array.from(ftsResults.entries()).sort((a, b) => a[1].rank - b[1].rank)) {
    const existing = scores.get(id);
    if (existing) {
      existing.ftsRank = ftsPos;
      existing.sources.push(result.source);
    } else {
      scores.set(id, { entry: result.entry, ftsRank: ftsPos, sources: [result.source] });
    }
    ftsPos++;
  }
  
  // Add vector scores
  let vecPos = 1;
  for (const [id, result] of Array.from(vectorResults.entries()).sort((a, b) => b[1].similarity - a[1].similarity)) {
    const existing = scores.get(id);
    if (existing) {
      existing.vecScore = vecPos;
      existing.sources.push("vector");
    } else {
      scores.set(id, { entry: result.entry, vecScore: vecPos, sources: ["vector"] });
    }
    vecPos++;
  }
  
  // Calculate RRF scores and prepare for graph boost
  const preBoosted: Array<{ id: string; entry: MemoryEntry; rrfScore: number; freshness: number; confidence: number; sources: string[] }> = [];

  for (const [id, result] of scores) {
    let rrfScore = 0;
    if (result.ftsRank) rrfScore += 1 / (k + result.ftsRank);
    if (result.vecScore) rrfScore += 1 / (k + result.vecScore);

    const nowSec2 = Math.floor(Date.now() / 1000);
    let freshness = 1;
    if (result.entry.expiresAt) {
      freshness = Math.max(0, Math.min(1, (result.entry.expiresAt - nowSec2) / (14 * 24 * 3600)));
    }

    preBoosted.push({
      id,
      entry: result.entry,
      rrfScore,
      freshness,
      confidence: result.entry.confidence,
      sources: result.sources,
    });
  }

  // Apply graph boost (reweights composite scores when links exist)
  const boosted = computeGraphBoost(db, preBoosted);

  // Inject graph-discovered neighbors (facts linked to top results but not in current set)
  const topIds = boosted
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 3)
    .map(r => r.id);
  const existingIds = new Set(boosted.map(r => r.id));
  const neighbors = findGraphNeighbors(db, topIds, existingIds, 2);

  const finalResults: Array<{ entry: MemoryEntry; score: number; sources: string[] }> = boosted.map(r => ({
    entry: r.entry,
    score: r.composite,
    sources: r.graphBoost > 0 ? [...r.sources, "graph"] : r.sources,
  }));

  // Add injected neighbors with a graph-only score
  for (const neighbor of neighbors) {
    const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(neighbor.factId) as Record<string, unknown>;
    if (fact) {
      finalResults.push({
        entry: rowToEntry(fact),
        score: neighbor.weight * 0.15, // Graph-only score
        sources: [`graph:${neighbor.relation}`],
      });
    }
  }

  finalResults.sort((a, b) => b.score - a.score);
  return finalResults.slice(0, limit);
}

// --- FTS-only Search (v1 compatible) ---
async function ftsSearch(query: string, options: { persona?: string; limit?: number } = {}): Promise<Array<{ entry: MemoryEntry; score: number }>> {
  const db = await initDb();
  const { persona, limit = 5 } = options;
  const nowSec = Math.floor(Date.now() / 1000);
  
  const safeQuery = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" OR ");
  
  if (!safeQuery) return [];
  
  const rows = db.prepare(`
    SELECT f.*, rank
    FROM facts f
    JOIN facts_fts fts ON f.rowid = fts.rowid
    WHERE facts_fts MATCH ?
      AND (f.expires_at IS NULL OR f.expires_at > ?)
      ${persona ? "AND f.persona = ?" : ""}
    ORDER BY rank
    LIMIT ?
  `).all(...[safeQuery, nowSec, ...(persona ? [persona] : []), limit]) as Array<Record<string, unknown>>;
  
  const minRank = rows.length > 0 ? Math.min(...rows.map((r) => r.rank as number)) : 0;
  const maxRank = rows.length > 0 ? Math.max(...rows.map((r) => r.rank as number)) : 1;
  const range = maxRank - minRank || 1;
  
  return rows.map((row) => ({
    entry: rowToEntry(row),
    score: 1 - ((row.rank as number) - minRank) / range || 0.8,
  }));
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    persona: row.persona as string,
    entity: row.entity as string,
    key: row.key as string | null,
    value: row.value as string,
    text: row.text as string,
    category: row.category as Category,
    decayClass: (row.decay_class as DecayClass) || "stable",
    importance: (row.importance as number) || 1.0,
    source: row.source as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number | null,
    lastAccessed: row.last_accessed as number,
    confidence: (row.confidence as number) || 1.0,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

// --- Backfill Embeddings ---
async function backfillEmbeddings(batchSize: number = 50): Promise<{ processed: number; failed: number }> {
  const db = await initDb();
  
  // Find facts without embeddings
  const facts = db.prepare(`
    SELECT f.* FROM facts f
    LEFT JOIN fact_embeddings fe ON f.id = fe.fact_id
    WHERE fe.fact_id IS NULL
    LIMIT ?
  `).all(batchSize) as Array<Record<string, unknown>>;
  
  let processed = 0;
  let failed = 0;
  
  for (const row of facts) {
    const text = row.text as string;
    const embedding = await getEmbedding(text);
    
    if (embedding) {
      db.prepare(`
        INSERT INTO fact_embeddings (fact_id, embedding, model)
        VALUES (?, ?, ?)
      `).run(row.id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
      processed++;
      process.stdout.write(".");
    } else {
      failed++;
      process.stdout.write("x");
    }
  }
  
  console.log();
  return { processed, failed };
}

// --- Stats ---
async function stats(): Promise<void> {
  const db = await initDb();
  
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM facts`).get() as { cnt: number };
  const withEmbeddings = db.prepare(`
    SELECT COUNT(*) as cnt FROM facts f
    JOIN fact_embeddings fe ON f.id = fe.fact_id
  `).get() as { cnt: number };
  const embeddingCount = db.prepare(`SELECT COUNT(*) as cnt FROM fact_embeddings`).get() as { cnt: number };
  
  console.log("Memory Statistics (v2):");
  console.log(`  Total facts: ${total.cnt}`);
  console.log(`  Facts with embeddings: ${withEmbeddings.cnt}`);
  console.log(`  Vector cache entries: ${embeddingCount.cnt}`);
  console.log(`  Embedding model: ${EMBEDDING_MODEL}`);
  console.log(`  Ollama URL: ${OLLAMA_URL}`);
}

// --- CLI Interface ---
function printUsage() {
  console.log(`
zo-memory-system v2 — Hybrid SQLite + Vector Search

Usage:
  bun memory-next.ts <command> [options]

Commands:
  store     Store a new fact with embedding
  search    FTS-only search (v1 compatible)
  hybrid    Hybrid search (FTS + vectors + HyDE)
  index     Backfill embeddings for existing facts
  stats     Show memory statistics

Store options:
  --entity <name>      Entity name (required)
  --key <name>         Key/attribute (optional)
  --value <text>       Value (required)
  --category <type>    preference|fact|decision|convention|other
  --decay <class>      permanent|stable|active|session|checkpoint
  --text <text>        Full context for embedding

Search options:
  --persona <name>     Filter by persona
  --limit <n>          Max results (default: 5/6)
  --no-hyde            Disable HyDE expansion

Examples:
  bun memory-next.ts store --entity "user" --key "name" --value "Alice"
  bun memory-next.ts hybrid "router password"
  bun memory-next.ts hybrid "project deadline" --no-hyde
  bun memory-next.ts index
  bun memory-next.ts stats
`);
}

async function main() {
  await initDb();
  
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }
  
  // Parse flags
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i] === "--no-hyde") {
        flags.hyde = "false";
      } else {
        flags[args[i].slice(2)] = args[i + 1] || "";
        i++;
      }
    } else {
      positional.push(args[i]);
    }
  }
  
  switch (command) {
    case "store": {
      if (!flags.entity || !flags.value) {
        console.error("Error: --entity and --value are required");
        process.exit(1);
      }
      const entry = await storeWithEmbedding({
        persona: flags.persona || "shared",
        entity: flags.entity,
        key: flags.key || null,
        value: flags.value,
        text: flags.text || `${flags.entity} ${flags.key || ""}: ${flags.value}`,
        category: (flags.category as Category) || "fact",
        decayClass: (flags.decay as DecayClass) || "stable",
        importance: parseFloat(flags.importance) || 1.0,
        source: flags.source || "cli",
        confidence: 1.0,
      });
      if (entry) {
        console.log(`Stored: ${entry.id}`);
        console.log(`Embedding: ${entry.embedding ? "generated" : "failed"}`);
      }
      break;
    }
    
    case "search": {
      const query = positional[0];
      if (!query) {
        console.error("Error: search query required");
        process.exit(1);
      }
      const results = await ftsSearch(query, {
        persona: flags.persona,
        limit: parseInt(flags.limit) || 5,
      });
      console.log(`Found ${results.length} results:\n`);
      for (const { entry, score } of results) {
        console.log(`[${entry.decayClass}] ${entry.entity}.${entry.key || "_"} = ${entry.value.slice(0, 80)}`);
        console.log(`    score: ${score.toFixed(3)}`);
        console.log();
      }
      break;
    }
    
    case "hybrid": {
      const query = positional[0];
      if (!query) {
        console.error("Error: search query required");
        process.exit(1);
      }
      console.log(`Searching: "${query}" ${flags.hyde === "false" ? "(no HyDE)" : "(with HyDE)"}\n`);
      const results = await hybridSearch(query, {
        persona: flags.persona,
        limit: parseInt(flags.limit) || 6,
        useHyde: flags.hyde !== "false",
      });
      console.log(`Found ${results.length} results:\n`);
      for (const { entry, score, sources } of results) {
        console.log(`[${entry.decayClass}] ${entry.entity}.${entry.key || "_"} = ${entry.value.slice(0, 80)}`);
        console.log(`    score: ${score.toFixed(3)} | sources: ${sources.join(", ")}`);
        console.log();
      }
      break;
    }
    
    case "index": {
      console.log("Backfilling embeddings...");
      const batch = parseInt(flags.batch) || 50;
      const { processed, failed } = await backfillEmbeddings(batch);
      console.log(`\nProcessed: ${processed}, Failed: ${failed}`);
      break;
    }
    
    case "stats": {
      await stats();
      break;
    }
    
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(console.error);
