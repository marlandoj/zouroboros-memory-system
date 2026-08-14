import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildInlineEvaluationTrace, validateDisposableDbPath } from "./eval-retrieval-trace";
import { formatInlineFtsResult, retrieveInlineFtsCandidates } from "./inline-fts";

const ROOT = "/home/workspace/Projects/mnemosyne-memory-spike-program/runtime/trace-test";
const DB_PATH = resolve(ROOT, "fixture.db");

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT,
      category TEXT,
      decay_class TEXT,
      source TEXT,
      confidence REAL,
      gate_status TEXT,
      expires_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE fact_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    );
  `);
  const insert = db.prepare(`
    INSERT INTO facts (
      id, entity, key, value, text, category, decay_class, source,
      confidence, gate_status, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  insert.run("fact-curated", "project.mnemosyne", "status", "pilot approved", "mnemosyne pilot approved", "fact", "active", "manual", 1, "allow", Date.now());
  insert.run("fact-low-confidence", "project.mnemosyne", "draft", "untrusted draft", "mnemosyne untrusted draft", "fact", "active", "auto:test", 0.1, "allow", Date.now());
  insert.run("fact-held", "project.mnemosyne", "held", "held result", "mnemosyne held result", "fact", "active", "manual", 1, "hold", Date.now());
  db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')");
  db.close();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("default-off evaluation retrieval trace", () => {
  test("uses the production inline ranker while excluding held and low-trust facts", () => {
    const result = retrieveInlineFtsCandidates({
      query: "mnemosyne pilot",
      dbPath: DB_PATH,
      limit: 20,
      confidenceFloor: 0.35,
      evaluationReadOnly: true,
    });
    expect(result.quarantined).toBe(1);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["fact-curated"]);
    expect(formatInlineFtsResult(result)).toContain("Found 1 results");
  });

  test("returns identifiers and numeric metadata without raw text or database writes", () => {
    const before = fileHash(DB_PATH);
    const trace = buildInlineEvaluationTrace({
      queryId: "a".repeat(64),
      effectiveQuery: "mnemosyne pilot",
      method: "continuation",
      dbPath: DB_PATH,
      allowedRoot: ROOT,
      confidenceFloor: 0.35,
    });
    const serialized = JSON.stringify(trace);
    expect(trace.candidates).toHaveLength(1);
    expect(trace.candidates[0].id).toBe("fact-curated");
    expect(serialized).not.toContain("mnemosyne pilot");
    expect(serialized).not.toContain("pilot approved");
    expect(fileHash(DB_PATH)).toBe(before);
  });

  test("rejects canonical memory databases and paths outside the disposable root", () => {
    expect(() => validateDisposableDbPath(
      "/home/workspace/.zo/memory/shared-facts.db",
      "/home/workspace",
    )).toThrow("canonical memory databases are forbidden");
    expect(() => validateDisposableDbPath(DB_PATH, "/home/workspace/Projects/other-root"))
      .toThrow();
  });
});
