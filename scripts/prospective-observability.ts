import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const CANONICAL_DATABASES = new Set([
  "/home/workspace/.zo/memory/shared-facts.db",
  "/home/workspace/.zo/memory/scorecard.db",
]);

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRIEVALS = 100;

export type ProspectiveCandidate = {
  id: string;
  rank: number;
  score: number;
};

export type ProspectiveRetrievalInput = {
  enabled?: boolean;
  observationDbPath?: string;
  allowedRoot?: string;
  sourceDbPath: string;
  traceId?: string;
  method: string;
  candidateIdsAvailable: boolean;
  candidates: ProspectiveCandidate[];
  latencyMs: number;
  timestampMs?: number;
  contentRoot?: string;
};

export type ProspectiveProvenanceInput = {
  db: Database;
  enabled?: boolean;
  traceId?: string;
  factId: string;
  source: string;
  captureMethod: string;
  insertFact: () => void;
  capturedAtSec?: number;
};

export type ProspectiveWindowConfig = {
  startMs: number;
  endMs: number;
  maxRetrievals: number;
  retentionMs: number;
};

export type ProspectiveCollectionStatus = {
  configured: boolean;
  active: boolean;
  reason: "disabled" | "invalid" | "pending" | "active" | "capped" | "expired" | "retention_expired";
  startMs?: number;
  endMs?: number;
  retentionUntilMs?: number;
  maxRetrievals?: number;
  retrievalCount: number;
  candidateCount: number;
};

function parseRequiredInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = env[name];
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range`);
  return parsed;
}

export function validateProspectiveWindowConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProspectiveWindowConfig {
  const startMs = parseRequiredInteger(env, "ZO_MEMORY_PROSPECTIVE_START_MS");
  const endMs = parseRequiredInteger(env, "ZO_MEMORY_PROSPECTIVE_END_MS");
  const maxRetrievals = parseRequiredInteger(env, "ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS");
  const retentionMs = parseRequiredInteger(env, "ZO_MEMORY_PROSPECTIVE_RETENTION_MS");
  if (endMs <= startMs || endMs - startMs > MAX_WINDOW_MS) {
    throw new Error("prospective collection window must be positive and at most 24 hours");
  }
  if (maxRetrievals < 1 || maxRetrievals > MAX_RETRIEVALS) {
    throw new Error("prospective retrieval cap must be between 1 and 100");
  }
  if (retentionMs > MAX_RETENTION_MS) {
    throw new Error("prospective retention must not exceed seven days");
  }
  if (!env.ZO_MEMORY_PROSPECTIVE_DB || !env.ZO_MEMORY_PROSPECTIVE_DB_ROOT) {
    throw new Error("prospective database path and allowed root are required");
  }
  validateProspectiveDbPath(env.ZO_MEMORY_PROSPECTIVE_DB, env.ZO_MEMORY_PROSPECTIVE_DB_ROOT);
  return { startMs, endMs, maxRetrievals, retentionMs };
}

export function prospectiveTraceEnabled(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): boolean {
  if (env.ZO_MEMORY_PROSPECTIVE_TRACE !== "1") return false;
  try {
    const status = getProspectiveCollectionStatus(env, nowMs);
    return status.active;
  } catch {
    return false;
  }
}

function validateIdentifier(value: string, label: string, maxLength = 256): void {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

export function validateProspectiveDbPath(dbPath: string, allowedRoot: string): string {
  if (!dbPath || !allowedRoot) throw new Error("prospective database path and allowed root are required");
  const resolvedDb = resolve(dbPath);
  if (CANONICAL_DATABASES.has(resolvedDb)) {
    throw new Error("canonical memory databases are forbidden");
  }

  mkdirSync(resolve(allowedRoot), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(resolvedDb), { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(resolve(allowedRoot));
  const realParent = realpathSync(dirname(resolvedDb));
  const fromRoot = relative(realRoot, realParent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("prospective database must remain inside the allowed root");
  }
  if (existsSync(resolvedDb)) {
    const realDb = realpathSync(resolvedDb);
    if (CANONICAL_DATABASES.has(realDb)) {
      throw new Error("canonical memory databases are forbidden");
    }
    const fileFromRoot = relative(realRoot, realDb);
    if (fileFromRoot === ".." || fileFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("prospective database symlink escapes the allowed root");
    }
  }
  return resolvedDb;
}

export function ensureProspectiveRetrievalSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prospective_retrievals (
      trace_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      method TEXT NOT NULL,
      candidate_ids_available INTEGER NOT NULL CHECK(candidate_ids_available IN (0, 1)),
      candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
      latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
      content_root TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prospective_candidates (
      trace_id TEXT NOT NULL REFERENCES prospective_retrievals(trace_id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK(rank > 0),
      score REAL NOT NULL,
      PRIMARY KEY(trace_id, rank)
    );
    CREATE INDEX IF NOT EXISTS idx_prospective_candidates_fact
      ON prospective_candidates(fact_id);
  `);
}

function readProspectiveCounts(dbPath: string): { retrievalCount: number; candidateCount: number } {
  if (!existsSync(dbPath)) return { retrievalCount: 0, candidateCount: 0 };
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('prospective_retrievals', 'prospective_candidates')
    `).all() as Array<{ name: string }>;
    if (tables.length !== 2) return { retrievalCount: 0, candidateCount: 0 };
    return {
      retrievalCount: (db.prepare("SELECT COUNT(*) AS count FROM prospective_retrievals").get() as { count: number }).count,
      candidateCount: (db.prepare("SELECT COUNT(*) AS count FROM prospective_candidates").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

export function getProspectiveCollectionStatus(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): ProspectiveCollectionStatus {
  if (env.ZO_MEMORY_PROSPECTIVE_TRACE !== "1") {
    return { configured: false, active: false, reason: "disabled", retrievalCount: 0, candidateCount: 0 };
  }
  try {
    const config = validateProspectiveWindowConfig(env);
    const dbPath = validateProspectiveDbPath(env.ZO_MEMORY_PROSPECTIVE_DB!, env.ZO_MEMORY_PROSPECTIVE_DB_ROOT!);
    const counts = readProspectiveCounts(dbPath);
    const base = {
      configured: true,
      startMs: config.startMs,
      endMs: config.endMs,
      retentionUntilMs: config.endMs + config.retentionMs,
      maxRetrievals: config.maxRetrievals,
      ...counts,
    };
    if (nowMs < config.startMs) return { ...base, active: false, reason: "pending" };
    if (nowMs >= config.endMs + config.retentionMs) return { ...base, active: false, reason: "retention_expired" };
    if (nowMs >= config.endMs) return { ...base, active: false, reason: "expired" };
    if (counts.retrievalCount >= config.maxRetrievals) return { ...base, active: false, reason: "capped" };
    return { ...base, active: true, reason: "active" };
  } catch {
    return { configured: false, active: false, reason: "invalid", retrievalCount: 0, candidateCount: 0 };
  }
}

export function purgeExpiredProspectiveObservations(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): boolean {
  if (env.ZO_MEMORY_PROSPECTIVE_TRACE !== "1") return false;
  const config = validateProspectiveWindowConfig(env);
  if (nowMs < config.endMs + config.retentionMs) return false;
  const dbPath = validateProspectiveDbPath(env.ZO_MEMORY_PROSPECTIVE_DB!, env.ZO_MEMORY_PROSPECTIVE_DB_ROOT!);
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    ensureProspectiveRetrievalSchema(db);
    db.transaction(() => {
      db.exec("DELETE FROM prospective_candidates");
      db.exec("DELETE FROM prospective_retrievals");
    })();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  chmodSync(dbPath, 0o600);
  return true;
}

function databaseContentRoot(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function recordProspectiveRetrieval(input: ProspectiveRetrievalInput): boolean {
  const enabled = input.enabled ?? prospectiveTraceEnabled();
  if (!enabled) return false;

  try {
    validateIdentifier(input.traceId ?? "", "trace ID", 128);
    validateIdentifier(input.method, "retrieval method", 80);
    if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0) {
      throw new Error("latency must be a non-negative integer");
    }
    if (!input.candidateIdsAvailable && input.candidates.length > 0) {
      throw new Error("unavailable candidate identifiers require an empty candidate list");
    }
    const seenRanks = new Set<number>();
    for (const candidate of input.candidates) {
      validateIdentifier(candidate.id, "fact ID");
      if (!Number.isInteger(candidate.rank) || candidate.rank < 1 || seenRanks.has(candidate.rank)) {
        throw new Error("candidate ranks must be unique positive integers");
      }
      if (!Number.isFinite(candidate.score)) throw new Error("candidate score must be finite");
      seenRanks.add(candidate.rank);
    }

    const dbPath = validateProspectiveDbPath(
      input.observationDbPath ?? process.env.ZO_MEMORY_PROSPECTIVE_DB ?? "",
      input.allowedRoot ?? process.env.ZO_MEMORY_PROSPECTIVE_DB_ROOT ?? "",
    );
    if (!existsSync(input.sourceDbPath)) throw new Error("retrieval source database is unavailable");
    const contentRoot = input.contentRoot ?? databaseContentRoot(input.sourceDbPath);
    if (!/^[a-f0-9]{64}$/.test(contentRoot)) throw new Error("content root is invalid");

    const db = new Database(dbPath, { create: true });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      ensureProspectiveRetrievalSchema(db);
      const write = db.transaction(() => {
        if (input.enabled === undefined) {
          const config = validateProspectiveWindowConfig();
          const count = (db.prepare("SELECT COUNT(*) AS count FROM prospective_retrievals").get() as { count: number }).count;
          if (count >= config.maxRetrievals) throw new Error("prospective retrieval cap reached");
        }
        db.prepare(`
          INSERT INTO prospective_retrievals (
            trace_id, ts, method, candidate_ids_available,
            candidate_count, latency_ms, content_root
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.traceId!,
          input.timestampMs ?? Date.now(),
          input.method,
          input.candidateIdsAvailable ? 1 : 0,
          input.candidates.length,
          input.latencyMs,
          contentRoot,
        );
        const insertCandidate = db.prepare(`
          INSERT INTO prospective_candidates (trace_id, fact_id, rank, score)
          VALUES (?, ?, ?, ?)
        `);
        for (const candidate of input.candidates) {
          insertCandidate.run(input.traceId!, candidate.id, candidate.rank, candidate.score);
        }
      });
      write();
    } finally {
      db.close();
    }
    chmodSync(dbPath, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function ensureProspectiveFactProvenanceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_provenance (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      capture_method TEXT,
      superseded_by TEXT REFERENCES facts(id),
      superseded_at INTEGER,
      effective_from INTEGER,
      effective_until INTEGER,
      metadata TEXT,
      trace_id TEXT,
      UNIQUE(fact_id, source)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(fact_provenance)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "trace_id")) {
    db.exec("ALTER TABLE fact_provenance ADD COLUMN trace_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_provenance_trace ON fact_provenance(trace_id)");
}

export function insertFactWithProspectiveProvenance(input: ProspectiveProvenanceInput): boolean {
  const enabled = input.enabled ?? prospectiveTraceEnabled();
  const traceId = input.traceId;
  if (!enabled || !traceId) {
    input.insertFact();
    return false;
  }

  try {
    validateIdentifier(traceId, "trace ID", 128);
    validateIdentifier(input.factId, "fact ID");
    if (!input.source || input.source.length > 500) throw new Error("provenance source is invalid");
    validateIdentifier(input.captureMethod, "capture method", 80);
    ensureProspectiveFactProvenanceSchema(input.db);
  } catch {
    input.insertFact();
    return false;
  }

  try {
    const write = input.db.transaction(() => {
      input.insertFact();
      const capturedAt = input.capturedAtSec ?? Math.floor(Date.now() / 1000);
      input.db.prepare(`
        INSERT OR IGNORE INTO fact_provenance (
          id, fact_id, source, captured_at, capture_method, effective_from, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.factId,
        input.source,
        capturedAt,
        input.captureMethod,
        capturedAt,
        traceId,
      );
    });
    write();
    return true;
  } catch {
    input.insertFact();
    return false;
  }
}
