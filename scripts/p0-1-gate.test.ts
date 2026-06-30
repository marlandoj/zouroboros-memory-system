import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  classifyWrite,
  recencyFactor,
  applyRecencyDecay,
  RECENCY_WEIGHT,
  findDuplicateId,
  decodeEmbedding,
  applyMerge,
  DEDUP_THRESHOLD,
  p0FlagOn,
  type GateVerdict,
} from "./p0-1-gate";

describe("P0-1 write-gate classifier (T2)", () => {
  const cases: Array<{ name: string; input: Parameters<typeof classifyWrite>[0]; want: GateVerdict }> = [
    // discard: too short
    { name: "empty value", input: { value: "" }, want: "discard" },
    { name: "whitespace only", input: { value: "      " }, want: "discard" },
    { name: "<12 chars", input: { value: "ok sure" }, want: "discard" },
    { name: "exactly 11 chars", input: { value: "12345678901" }, want: "discard" },
    // discard: instruction echo / acknowledgement
    { name: "ack 'noted'", input: { value: "Noted." }, want: "discard" },
    { name: "ack 'got it'", input: { value: "got it!" }, want: "discard" },
    { name: "echo 'remember to'", input: { value: "Remember to restart the daemon after edits" }, want: "discard" },
    { name: "echo 'I will make sure'", input: { value: "I'll make sure to mirror the change" }, want: "discard" },
    { name: "echo 'as you requested'", input: { value: "As you requested, here is the summary text" }, want: "discard" },
    // hold: low-signal auto-capture below confidence floor
    { name: "auto source + low conf", input: { value: "the user mentioned a possible preference", source: "fact-extractor", confidence: 0.2 }, want: "hold" },
    { name: "mimir source + low conf", input: { value: "synthesized claim that may be stale now", source: "mimir-synthesis", confidence: 0.34 }, want: "hold" },
    // allow: normal durable facts
    { name: "normal fact", input: { value: "Aventurine Capital is spelled with a gemstone, not Adventuring" }, want: "allow" },
    { name: "auto source but high conf", input: { value: "JHF options layer uses polygon_options cache", source: "fact-extractor", confidence: 0.9 }, want: "allow" },
    { name: "curated source low conf is NOT held", input: { value: "user prefers terse responses with no summaries", source: "curated", confidence: 0.1 }, want: "allow" },
    { name: "auto source null conf is NOT held", input: { value: "some auto fact with unknown confidence value", source: "auto", confidence: null }, want: "allow" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(classifyWrite(c.input)).toBe(c.want);
    });
  }

  test("deterministic: same input → same verdict across repeated calls", () => {
    const input = { value: "the user mentioned a possible preference", source: "fact-extractor", confidence: 0.2 };
    const verdicts = Array.from({ length: 50 }, () => classifyWrite(input));
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe("hold");
  });
});

describe("P0-1 ACT-R recency factor (T4)", () => {
  const nowSec = Date.now() / 1000;

  test("factor is in (0,1]", () => {
    const f = recencyFactor(nowSec, nowSec);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThanOrEqual(1);
  });

  test("more recently created ranks higher (monotonic)", () => {
    const fresh = recencyFactor(nowSec - 60, nowSec - 60);
    const old = recencyFactor(nowSec - 90 * 24 * 3600, nowSec - 90 * 24 * 3600);
    expect(fresh).toBeGreaterThan(old);
  });

  test("more recently ACCESSED ranks higher even if created same", () => {
    const created = nowSec - 30 * 24 * 3600;
    const accessedRecently = recencyFactor(created, nowSec - 60);
    const accessedLongAgo = recencyFactor(created, created);
    expect(accessedRecently).toBeGreaterThan(accessedLongAgo);
  });

  test("not a literal constant — varies with input (sourced from calculateBaseLevel)", () => {
    const a = recencyFactor(nowSec - 1, nowSec - 1);
    const b = recencyFactor(nowSec - 1_000_000, nowSec - 1_000_000);
    expect(a).not.toBeCloseTo(b, 5);
  });

  test("applyRecencyDecay: two facts equal on composite, fresher wins", () => {
    const composite = 0.5;
    const freshScore = applyRecencyDecay(composite, recencyFactor(nowSec - 60, nowSec - 60));
    const oldScore = applyRecencyDecay(composite, recencyFactor(nowSec - 90 * 24 * 3600, nowSec - 90 * 24 * 3600));
    expect(freshScore).toBeGreaterThan(oldScore);
  });

  test("applyRecencyDecay: weight=0 ⇒ unchanged (flag-off parity)", () => {
    expect(applyRecencyDecay(0.42, 0.001, 0)).toBe(0.42);
    expect(applyRecencyDecay(0.42, 0.999, 0)).toBe(0.42);
  });

  test("applyRecencyDecay: recency=1 ⇒ unchanged; band is [1-w,1]", () => {
    expect(applyRecencyDecay(1, 1, RECENCY_WEIGHT)).toBeCloseTo(1, 10);
    expect(applyRecencyDecay(1, 0, RECENCY_WEIGHT)).toBeCloseTo(1 - RECENCY_WEIGHT, 10);
  });
});

describe("P0-1 dedup-merge (T3)", () => {
  test("decodeEmbedding round-trips a Float32 blob", () => {
    const vec = [0.1, -0.2, 0.3, 0.4];
    const blob = new Uint8Array(new Float32Array(vec).buffer);
    const back = decodeEmbedding(blob);
    expect(back.length).toBe(4);
    for (let i = 0; i < vec.length; i++) expect(back[i]).toBeCloseTo(vec[i], 6);
  });

  test("findDuplicateId: cosine>0.85 matches, near-orthogonal does not", () => {
    const candidate = [1, 0, 0, 0];
    const nearDup = [0.99, 0.05, 0.02, 0]; // cosine ≈ 0.998
    const distinct = [0, 1, 0, 0]; // cosine 0
    expect(findDuplicateId(candidate, [{ id: "a", embedding: nearDup }])).toBe("a");
    expect(findDuplicateId(candidate, [{ id: "b", embedding: distinct }])).toBeNull();
  });

  test("findDuplicateId: picks the highest-cosine candidate above threshold", () => {
    const candidate = [1, 0, 0];
    const rows = [
      { id: "lo", embedding: [0.88, 0.4, 0.2] }, // ~0.89
      { id: "hi", embedding: [0.999, 0.02, 0.0] }, // ~0.9998
    ];
    expect(findDuplicateId(candidate, rows)).toBe("hi");
  });

  test("findDuplicateId: just-below threshold ⇒ no match, just-above ⇒ match", () => {
    const candidate = [1, 0];
    const below = [Math.cos(Math.acos(0.80)), Math.sin(Math.acos(0.80))]; // cosine ≈ 0.80
    const above = [Math.cos(Math.acos(0.90)), Math.sin(Math.acos(0.90))]; // cosine ≈ 0.90
    expect(findDuplicateId(candidate, [{ id: "below", embedding: below }])).toBeNull();
    expect(findDuplicateId(candidate, [{ id: "above", embedding: above }])).toBe("above");
  });

  test("applyMerge: increments merged_count + bumps last_accessed, keeps created_at, row count stable", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE facts (
      id TEXT PRIMARY KEY, entity TEXT, value TEXT,
      created_at INTEGER, last_accessed INTEGER,
      merged_count INTEGER NOT NULL DEFAULT 0, gate_status TEXT NOT NULL DEFAULT 'allow'
    )`);
    const createdAt = 1_700_000_000_000;
    db.prepare("INSERT INTO facts (id, entity, value, created_at, last_accessed) VALUES (?,?,?,?,?)")
      .run("f1", "JHF", "options layer uses polygon cache", createdAt, 1_700_000_000);

    const before = (db.prepare("SELECT COUNT(*) c FROM facts").get() as { c: number }).c;
    applyMerge(db, "f1", 1_700_000_999);
    applyMerge(db, "f1", 1_700_001_000);
    const after = (db.prepare("SELECT COUNT(*) c FROM facts").get() as { c: number }).c;
    const row = db.prepare("SELECT * FROM facts WHERE id='f1'").get() as any;

    expect(after).toBe(before); // no new row
    expect(row.merged_count).toBe(2);
    expect(row.last_accessed).toBe(1_700_001_000);
    expect(row.created_at).toBe(createdAt); // provenance preserved
    db.close();
  });
});

describe("P0-1 config flags", () => {
  const KEY = "MEMORY_TEST_FLAG_XYZ";
  test("default ON when unset", () => {
    delete process.env[KEY];
    expect(p0FlagOn(KEY)).toBe(true);
  });
  test("off values disable", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off"]) {
      process.env[KEY] = v;
      expect(p0FlagOn(KEY)).toBe(false);
    }
    delete process.env[KEY];
  });
  test("any other value keeps it on", () => {
    process.env[KEY] = "1";
    expect(p0FlagOn(KEY)).toBe(true);
    process.env[KEY] = "yes";
    expect(p0FlagOn(KEY)).toBe(true);
    delete process.env[KEY];
  });
});
