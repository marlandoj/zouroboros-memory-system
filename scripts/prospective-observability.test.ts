import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureProspectiveFactProvenanceSchema,
  getProspectiveCollectionStatus,
  insertFactWithProspectiveProvenance,
  purgeExpiredProspectiveObservations,
  prospectiveTraceEnabled,
  recordProspectiveRetrieval,
  validateProspectiveWindowConfig,
  validateProspectiveDbPath,
} from "./prospective-observability";
import { logGateDecision, logRetrieval } from "./scorecard";

const ROOT = "/home/workspace/Projects/mnemosyne-memory-spike-program/runtime/prospective-test";
const SOURCE_DB = resolve(ROOT, "source.sqlite");
const OBS_DB = resolve(ROOT, "observations.sqlite");
const SCORECARD_DB = resolve(ROOT, "scorecard.sqlite");

function createSourceDb(): void {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const db = new Database(SOURCE_DB, { create: true });
  db.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run("fact-1", "private source text");
  db.close();
  chmodSync(SOURCE_DB, 0o600);
}

afterEach(() => {
  delete process.env.ZO_SCORECARD_DB;
  for (const name of [
    "ZO_MEMORY_PROSPECTIVE_TRACE",
    "ZO_MEMORY_PROSPECTIVE_DB",
    "ZO_MEMORY_PROSPECTIVE_DB_ROOT",
    "ZO_MEMORY_PROSPECTIVE_START_MS",
    "ZO_MEMORY_PROSPECTIVE_END_MS",
    "ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS",
    "ZO_MEMORY_PROSPECTIVE_RETENTION_MS",
  ]) delete process.env[name];
  rmSync(ROOT, { recursive: true, force: true });
});

describe("ZOU-795 prospective retrieval observations", () => {
  test("is default-off and creates no artifact", () => {
    createSourceDb();
    expect(prospectiveTraceEnabled({})).toBe(false);
    expect(recordProspectiveRetrieval({
      enabled: false,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId: "11111111-1111-4111-8111-111111111111",
      method: "keyword_heuristic",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 4,
    })).toBe(false);
    expect(existsSync(OBS_DB)).toBe(false);
  });

  test("fails closed when enabled without explicit bounds", () => {
    const env = { ZO_MEMORY_PROSPECTIVE_TRACE: "1" };
    expect(prospectiveTraceEnabled(env, 1)).toBe(false);
    expect(() => validateProspectiveWindowConfig(env)).toThrow("ZO_MEMORY_PROSPECTIVE_START_MS");
    expect(getProspectiveCollectionStatus(env, 1).reason).toBe("invalid");
  });

  test("stops after the approved retrieval cap", () => {
    createSourceDb();
    const now = Date.now();
    Object.assign(process.env, {
      ZO_MEMORY_PROSPECTIVE_TRACE: "1",
      ZO_MEMORY_PROSPECTIVE_DB: OBS_DB,
      ZO_MEMORY_PROSPECTIVE_DB_ROOT: ROOT,
      ZO_MEMORY_PROSPECTIVE_START_MS: String(now - 1_000),
      ZO_MEMORY_PROSPECTIVE_END_MS: String(now + 60_000),
      ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS: "1",
      ZO_MEMORY_PROSPECTIVE_RETENTION_MS: "1000",
    });
    const first = recordProspectiveRetrieval({
      sourceDbPath: SOURCE_DB,
      traceId: "99999999-9999-4999-8999-999999999991",
      method: "keyword_heuristic",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 1,
    });
    const second = recordProspectiveRetrieval({
      sourceDbPath: SOURCE_DB,
      traceId: "99999999-9999-4999-8999-999999999992",
      method: "keyword_heuristic",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 1,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(prospectiveTraceEnabled(process.env, now)).toBe(false);
    expect(getProspectiveCollectionStatus(process.env, now)).toMatchObject({
      active: false,
      reason: "capped",
      retrievalCount: 1,
      maxRetrievals: 1,
    });
  });

  test("purges observations only after the retention deadline", () => {
    createSourceDb();
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId: "99999999-9999-4999-8999-999999999993",
      method: "keyword_heuristic",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 1,
    })).toBe(true);
    const env = {
      ZO_MEMORY_PROSPECTIVE_TRACE: "1",
      ZO_MEMORY_PROSPECTIVE_DB: OBS_DB,
      ZO_MEMORY_PROSPECTIVE_DB_ROOT: ROOT,
      ZO_MEMORY_PROSPECTIVE_START_MS: "1000",
      ZO_MEMORY_PROSPECTIVE_END_MS: "2000",
      ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS: "100",
      ZO_MEMORY_PROSPECTIVE_RETENTION_MS: "1000",
    };
    expect(purgeExpiredProspectiveObservations(env, 2_999)).toBe(false);
    expect(purgeExpiredProspectiveObservations(env, 3_000)).toBe(true);
    const db = new Database(OBS_DB, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM prospective_retrievals").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM prospective_candidates").get() as { count: number }).count).toBe(0);
    db.close();
    expect(getProspectiveCollectionStatus(env, 3_000).reason).toBe("retention_expired");
  });

  test("rejects windows or retention beyond the approved limits", () => {
    const base = {
      ZO_MEMORY_PROSPECTIVE_TRACE: "1",
      ZO_MEMORY_PROSPECTIVE_DB: OBS_DB,
      ZO_MEMORY_PROSPECTIVE_DB_ROOT: ROOT,
      ZO_MEMORY_PROSPECTIVE_START_MS: "1",
      ZO_MEMORY_PROSPECTIVE_END_MS: String(24 * 60 * 60 * 1000 + 2),
      ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS: "100",
      ZO_MEMORY_PROSPECTIVE_RETENTION_MS: "0",
    };
    expect(() => validateProspectiveWindowConfig(base)).toThrow("at most 24 hours");
    expect(() => validateProspectiveWindowConfig({
      ...base,
      ZO_MEMORY_PROSPECTIVE_END_MS: "2",
      ZO_MEMORY_PROSPECTIVE_RETENTION_MS: String(7 * 24 * 60 * 60 * 1000 + 1),
    })).toThrow("must not exceed seven days");
  });

  test("stores only the frozen identifier and numeric schema", () => {
    createSourceDb();
    const traceId = "22222222-2222-4222-8222-222222222222";
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId,
      method: "continuation",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 7,
      timestampMs: 42,
    })).toBe(true);

    const db = new Database(OBS_DB, { readonly: true });
    const retrieval = db.prepare("SELECT * FROM prospective_retrievals").get() as Record<string, unknown>;
    const candidate = db.prepare("SELECT * FROM prospective_candidates").get() as Record<string, unknown>;
    const retrievalColumns = (db.prepare("PRAGMA table_info(prospective_retrievals)").all() as Array<{ name: string }>).map((row) => row.name);
    const candidateColumns = (db.prepare("PRAGMA table_info(prospective_candidates)").all() as Array<{ name: string }>).map((row) => row.name);
    db.close();

    expect(retrieval.trace_id).toBe(traceId);
    expect(retrieval.candidate_ids_available).toBe(1);
    expect(retrieval.candidate_count).toBe(1);
    expect(candidate.fact_id).toBe("fact-1");
    expect(candidate.rank).toBe(1);
    expect(candidate.score).toBe(0.75);
    expect(retrievalColumns).toEqual([
      "trace_id", "ts", "method", "candidate_ids_available",
      "candidate_count", "latency_ms", "content_root",
    ]);
    expect(candidateColumns).toEqual(["trace_id", "fact_id", "rank", "score"]);
    expect(readFileSync(OBS_DB).includes(Buffer.from("private source text"))).toBe(false);
    expect(Bun.file(OBS_DB).stat().then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
  });

  test("records fallback incompleteness without manufacturing candidates", () => {
    createSourceDb();
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId: "33333333-3333-4333-8333-333333333333",
      method: "hybrid_fallback",
      candidateIdsAvailable: false,
      candidates: [],
      latencyMs: 15,
    })).toBe(true);
    const db = new Database(OBS_DB, { readonly: true });
    const row = db.prepare("SELECT candidate_ids_available, candidate_count FROM prospective_retrievals").get() as Record<string, number>;
    expect(row).toEqual({ candidate_ids_available: 0, candidate_count: 0 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM prospective_candidates").get() as { count: number }).count).toBe(0);
    db.close();
  });

  test("fails closed on invalid paths and malformed candidates", () => {
    createSourceDb();
    expect(() => validateProspectiveDbPath(
      "/home/workspace/.zo/memory/scorecard.db",
      "/home/workspace",
    )).toThrow("canonical memory databases are forbidden");
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: resolve(ROOT, "outside", "..", "..", "escape.sqlite"),
      allowedRoot: resolve(ROOT, "allowed"),
      sourceDbPath: SOURCE_DB,
      traceId: "44444444-4444-4444-8444-444444444444",
      method: "continuation",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: Number.NaN }],
      latencyMs: 1,
    })).toBe(false);
  });

  test("rejects an observation symlink that escapes the allowed root", () => {
    createSourceDb();
    const outside = resolve(ROOT, "..", "outside-observations.sqlite");
    writeFileSync(outside, "not a database", { mode: 0o600 });
    symlinkSync(outside, OBS_DB);
    expect(() => validateProspectiveDbPath(OBS_DB, ROOT))
      .toThrow("prospective database symlink escapes the allowed root");
    rmSync(outside, { force: true });
  });

  test("uses a deterministic source content root", () => {
    createSourceDb();
    const expected = createHash("sha256").update(readFileSync(SOURCE_DB)).digest("hex");
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId: "55555555-5555-4555-8555-555555555555",
      method: "wikilink_fast_path",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 1 }],
      latencyMs: 2,
    })).toBe(true);
    const db = new Database(OBS_DB, { readonly: true });
    expect((db.prepare("SELECT content_root FROM prospective_retrievals").get() as { content_root: string }).content_root).toBe(expected);
    db.close();
  });

  test("joins gate, retrieval, candidates, and provenance by one trace ID", () => {
    createSourceDb();
    const traceId = "88888888-8888-4888-8888-888888888888";
    process.env.ZO_SCORECARD_DB = SCORECARD_DB;
    logGateDecision({
      exitCode: 0,
      method: "keyword_heuristic",
      memoryFound: true,
      latencyMs: 3,
      sessionId: traceId,
    });
    logRetrieval({
      query: "private query retained only by the incumbent scorecard",
      chunksReturned: 1,
      method: "keyword_heuristic",
      latencyMs: 4,
      sessionId: traceId,
    });
    expect(recordProspectiveRetrieval({
      enabled: true,
      observationDbPath: OBS_DB,
      allowedRoot: ROOT,
      sourceDbPath: SOURCE_DB,
      traceId,
      method: "keyword_heuristic",
      candidateIdsAvailable: true,
      candidates: [{ id: "fact-1", rank: 1, score: 0.75 }],
      latencyMs: 4,
    })).toBe(true);

    const source = new Database(SOURCE_DB);
    expect(insertFactWithProspectiveProvenance({
      db: source,
      enabled: true,
      traceId,
      factId: "fact-joined",
      source: "fact-extractor:inline:test",
      captureMethod: "inline",
      insertFact: () => {
        source.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run("fact-joined", "joined fact");
      },
    })).toBe(true);
    const provenanceTrace = (source.prepare("SELECT trace_id FROM fact_provenance WHERE fact_id = ?").get("fact-joined") as { trace_id: string }).trace_id;
    source.close();

    const scorecard = new Database(SCORECARD_DB, { readonly: true });
    const gateTrace = (scorecard.prepare("SELECT session_id FROM gate_decisions").get() as { session_id: string }).session_id;
    const retrievalTrace = (scorecard.prepare("SELECT session_id FROM memory_retrievals").get() as { session_id: string }).session_id;
    scorecard.close();
    const observations = new Database(OBS_DB, { readonly: true });
    const observationTrace = (observations.prepare("SELECT trace_id FROM prospective_retrievals").get() as { trace_id: string }).trace_id;
    const candidateTrace = (observations.prepare("SELECT trace_id FROM prospective_candidates").get() as { trace_id: string }).trace_id;
    observations.close();

    expect([gateTrace, retrievalTrace, observationTrace, candidateTrace, provenanceTrace])
      .toEqual([traceId, traceId, traceId, traceId, traceId]);
  });
});

describe("ZOU-795 prospective fact provenance", () => {
  test("migrates trace_id idempotently while preserving existing rows", () => {
    createSourceDb();
    const db = new Database(SOURCE_DB);
    db.exec(`
      CREATE TABLE fact_provenance (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        capture_method TEXT,
        effective_from INTEGER,
        UNIQUE(fact_id, source)
      );
      INSERT INTO fact_provenance (id, fact_id, source, captured_at)
      VALUES ('old-provenance', 'fact-1', 'legacy', 1);
    `);
    ensureProspectiveFactProvenanceSchema(db);
    ensureProspectiveFactProvenanceSchema(db);
    const columns = db.prepare("PRAGMA table_info(fact_provenance)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "trace_id")).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS count FROM fact_provenance").get() as { count: number }).count).toBe(1);
    db.close();
  });

  test("inserts a fact and its trace provenance atomically", () => {
    createSourceDb();
    const db = new Database(SOURCE_DB);
    const factId = "fact-2";
    expect(insertFactWithProspectiveProvenance({
      db,
      enabled: true,
      traceId: "66666666-6666-4666-8666-666666666666",
      factId,
      source: "fact-extractor:inline:test",
      captureMethod: "inline",
      capturedAtSec: 10,
      insertFact: () => {
        db.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run(factId, "new fact");
      },
    })).toBe(true);
    const row = db.prepare("SELECT fact_id, source, capture_method, trace_id FROM fact_provenance WHERE fact_id = ?").get(factId) as Record<string, unknown>;
    expect(row).toEqual({
      fact_id: factId,
      source: "fact-extractor:inline:test",
      capture_method: "inline",
      trace_id: "66666666-6666-4666-8666-666666666666",
    });
    db.close();
  });

  test("preserves the incumbent fact insert if provenance cannot write", () => {
    createSourceDb();
    const db = new Database(SOURCE_DB);
    db.exec("CREATE TABLE fact_provenance (id TEXT PRIMARY KEY, trace_id TEXT)");
    const factId = "fact-3";
    expect(insertFactWithProspectiveProvenance({
      db,
      enabled: true,
      traceId: "77777777-7777-4777-8777-777777777777",
      factId,
      source: "fact-extractor:inline:test",
      captureMethod: "inline",
      insertFact: () => {
        db.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run(factId, "fallback fact");
      },
    })).toBe(false);
    expect((db.prepare("SELECT value FROM facts WHERE id = ?").get(factId) as { value: string }).value).toBe("fallback fact");
    db.close();
  });
});
