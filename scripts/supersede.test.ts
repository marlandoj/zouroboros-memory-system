import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  supersededSet,
  supersedingFact,
  supersedePenalty,
  applySupersedePenalty,
  supersedeSuppressOn,
  SUPERSEDE_RELATIONS,
  DEFAULT_SUPERSEDE_PENALTY,
} from "./supersede";

const NOW = Math.floor(Date.now() / 1000);

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, entity TEXT, value TEXT,
      created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE fact_links (
      source_id TEXT, target_id TEXT, relation TEXT DEFAULT 'related', weight REAL DEFAULT 1.0,
      PRIMARY KEY (source_id, target_id, relation)
    );
  `);
  return db;
}

function addFact(db: Database, id: string, opts: { createdAt?: number; expiresAt?: number | null } = {}) {
  db.prepare("INSERT INTO facts (id, entity, value, created_at, expires_at) VALUES (?,?,?,?,?)")
    .run(id, "X", `value-${id}`, opts.createdAt ?? NOW * 1000, opts.expiresAt ?? null);
}

function link(db: Database, source: string, target: string, relation = "supersedes") {
  db.prepare("INSERT INTO fact_links (source_id, target_id, relation, weight) VALUES (?,?,?,1.0)")
    .run(source, target, relation);
}

describe("supersededSet — direction invariant (T1)", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  test("A supersedes B ⇒ B is stale, A is not", () => {
    addFact(db, "A"); addFact(db, "B");
    link(db, "A", "B"); // source=new A, target=old B
    const set = supersededSet(db, ["A", "B"]);
    expect(set.has("B")).toBe(true);
    expect(set.has("A")).toBe(false);
  });

  test("empty candidate list ⇒ empty set, no query error", () => {
    expect(supersededSet(db, []).size).toBe(0);
  });

  test("only returns candidates that are actually superseded", () => {
    addFact(db, "A"); addFact(db, "B"); addFact(db, "C");
    link(db, "A", "B");
    const set = supersededSet(db, ["A", "B", "C"]);
    expect([...set].sort()).toEqual(["B"]);
  });
});

describe("supersededSet — live-source guard", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  test("expired superseding source ⇒ target NOT suppressed (no orphan suppression)", () => {
    addFact(db, "A", { expiresAt: NOW - 100 }); // source expired
    addFact(db, "B");
    link(db, "A", "B");
    expect(supersededSet(db, ["A", "B"]).has("B")).toBe(false);
  });

  test("deleted superseding source ⇒ target NOT suppressed", () => {
    addFact(db, "B");
    link(db, "ghost", "B"); // source row never inserted
    expect(supersededSet(db, ["B"]).has("B")).toBe(false);
  });

  test("non-expired source (future expiry) ⇒ target suppressed", () => {
    addFact(db, "A", { expiresAt: NOW + 10_000 });
    addFact(db, "B");
    link(db, "A", "B");
    expect(supersededSet(db, ["A", "B"]).has("B")).toBe(true);
  });
});

describe("supersededSet — relation scope includes update_of", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  test("update_of edge also suppresses its target", () => {
    addFact(db, "A"); addFact(db, "B");
    link(db, "A", "B", "update_of");
    expect(supersededSet(db, ["A", "B"]).has("B")).toBe(true);
  });

  test("a non-temporal relation (related) does NOT suppress", () => {
    addFact(db, "A"); addFact(db, "B");
    link(db, "A", "B", "related");
    expect(supersededSet(db, ["A", "B"]).has("B")).toBe(false);
  });

  test("SUPERSEDE_RELATIONS is the documented set", () => {
    expect([...SUPERSEDE_RELATIONS]).toEqual(["supersedes", "update_of"]);
  });
});

describe("supersedingFact", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  test("returns the newest live source that supersedes the stale id", () => {
    addFact(db, "old");
    addFact(db, "newer", { createdAt: 1000 });
    addFact(db, "newest", { createdAt: 9000 });
    link(db, "newer", "old");
    link(db, "newest", "old");
    expect(supersedingFact(db, "old")).toBe("newest");
  });

  test("returns null when nothing supersedes it", () => {
    addFact(db, "solo");
    expect(supersedingFact(db, "solo")).toBeNull();
  });

  test("skips an expired superseding source", () => {
    addFact(db, "old");
    addFact(db, "expired", { createdAt: 9000, expiresAt: NOW - 1 });
    addFact(db, "live", { createdAt: 1000 });
    link(db, "expired", "old");
    link(db, "live", "old");
    expect(supersedingFact(db, "old")).toBe("live");
  });
});

describe("supersedePenalty + applySupersedePenalty", () => {
  const KEY = "MEMORY_SUPERSEDE_PENALTY";
  const SW = "MEMORY_SUPERSEDE_SUPPRESS";
  afterEach(() => { delete process.env[KEY]; delete process.env[SW]; });

  test("default penalty is 0.3 when unset", () => {
    delete process.env[KEY];
    expect(supersedePenalty()).toBeCloseTo(DEFAULT_SUPERSEDE_PENALTY, 6);
  });

  test("clamps out-of-range and ignores non-numeric", () => {
    process.env[KEY] = "-5"; expect(supersedePenalty()).toBe(0);
    process.env[KEY] = "2";  expect(supersedePenalty()).toBe(1);
    process.env[KEY] = "abc"; expect(supersedePenalty()).toBeCloseTo(0.3, 6);
  });

  test("applySupersedePenalty downranks a superseded score when flag on", () => {
    delete process.env[SW];
    process.env[KEY] = "0.3";
    expect(applySupersedePenalty(1.0, true)).toBeCloseTo(0.3, 6);
    expect(applySupersedePenalty(1.0, false)).toBe(1.0); // not superseded ⇒ identity
  });

  test("includeSuperseded bypasses the penalty", () => {
    process.env[KEY] = "0.3";
    expect(applySupersedePenalty(1.0, true, true)).toBe(1.0);
  });

  test("flag off ⇒ identity (rollback parity)", () => {
    process.env[SW] = "0";
    expect(supersedeSuppressOn()).toBe(false);
    expect(applySupersedePenalty(1.0, true)).toBe(1.0);
  });

  test("flag default ON", () => {
    delete process.env[SW];
    expect(supersedeSuppressOn()).toBe(true);
  });
});
