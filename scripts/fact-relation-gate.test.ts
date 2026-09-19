import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureRelationReceiptSchema, relationMode, resolveFactRelation, writeRelationReceipt, type RelationAction } from "./fact-extractor";

const SECRET = "The user prefers dark mode and lives in Phoenix";
let dir = "";
let stub = "";

const STUB = `#!/usr/bin/env python3
import json, os, sys, time
pair = json.loads(sys.stdin.read())
mode = sys.argv[sys.argv.index("--mode") + 1]
kind = os.environ.get("STUB_KIND", "refine")
if kind == "hang":
    time.sleep(30)
if kind == "garbage":
    sys.stdout.write("not json\\n"); sys.exit(0)
if kind == "invalid":
    sys.stdout.write(json.dumps({"schema_version": "jev-fact-relation/v1", "status": "invalid", "reason": "x"}) + "\\n"); sys.exit(2)
rel = {"refine": "refinement", "skip": "duplicate", "coexist": "unrelated", "supersede": "contradiction"}[kind]
act = kind
status = os.environ.get("STUB_STATUS", "assessed")
effective = {"relation": rel, "action": act} if (mode == "advise" and status == "assessed") else {"relation": "contradiction", "action": "supersede"}
sys.stdout.write(json.dumps({
  "schema_version": "jev-fact-relation/v1", "adapter_version": "1.0.0", "mode": mode, "status": status,
  "reason": "model_recommendation", "model": "jev-1.13.0", "policy_version": "fact-relation-v1",
  "existing_id": pair["existing"]["id"], "entity": pair["entity"], "key": pair["key"],
  "pair_digest": "abc", "request_digest": "def", "elapsed_ms": 12.5,
  "recommendation": {"relation": rel, "action": act}, "effective": effective,
  "answers": {"relation": {"type": "choice", "choice": rel, "probabilities": {rel: 0.9}, "confidence": 0.9},
              "incompatible": {"type": "noul", "noul": 0.1}, "same_information": {"type": "noul", "noul": 0.2}},
  "usage": {"input_tokens": 400}, "estimated_cost_usd": 0.0000168}) + "\\n")
`;

const input = {
  entity: "user",
  key: "preference",
  existingId: "old-1",
  existingValue: SECRET,
  candidateValue: SECRET + ", and uses Arizona time",
  source: "inline:test",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fact-relation-"));
  stub = join(dir, "stub.py");
  writeFileSync(stub, STUB);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withKind(kind: string, status = "assessed") {
  process.env.STUB_KIND = kind;
  process.env.STUB_STATUS = status;
}

describe("relationMode", () => {
  test("defaults to off and rejects unknown values", () => {
    const prev = process.env.JEV_FACT_RELATION_MODE;
    delete process.env.JEV_FACT_RELATION_MODE;
    expect(relationMode()).toBe("off");
    process.env.JEV_FACT_RELATION_MODE = "SHADOW ";
    expect(relationMode()).toBe("shadow");
    process.env.JEV_FACT_RELATION_MODE = "yes";
    expect(relationMode()).toBe("off");
    if (prev === undefined) delete process.env.JEV_FACT_RELATION_MODE; else process.env.JEV_FACT_RELATION_MODE = prev;
  });
});

describe("resolveFactRelation", () => {
  test("off mode never spawns and keeps supersede", async () => {
    const d = await resolveFactRelation(input, { mode: "off", script: "/nonexistent/script.py" });
    expect(d.action).toBe("supersede");
    expect(d.receipt).toBeNull();
  });

  test("shadow keeps supersede while recording the recommendation", async () => {
    withKind("skip");
    const d = await resolveFactRelation(input, { mode: "shadow", script: stub });
    expect(d.action).toBe("supersede");
    expect(d.receipt?.recommendation.relation).toBe("duplicate");
    expect(d.receipt?.status).toBe("assessed");
  });

  test("advise maps assessed relations to actions", async () => {
    const cases: Array<[string, RelationAction]> = [["skip", "skip"], ["refine", "refine"], ["coexist", "coexist"], ["supersede", "supersede"]];
    for (const [kind, action] of cases) {
      withKind(kind);
      const d = await resolveFactRelation(input, { mode: "advise", script: stub });
      expect(d.action).toBe(action);
    }
  });

  test("advise falls back to supersede when the receipt is review or fallback", async () => {
    withKind("skip", "review");
    const d = await resolveFactRelation(input, { mode: "advise", script: stub });
    expect(d.action).toBe("supersede");
  });

  test("garbage, invalid, missing script and timeout all fall back", async () => {
    withKind("garbage");
    expect((await resolveFactRelation(input, { mode: "advise", script: stub })).receipt?.reason).toBe("invalid_receipt");
    withKind("invalid");
    expect((await resolveFactRelation(input, { mode: "advise", script: stub })).receipt?.reason).toBe("invalid_receipt");
    const missing = await resolveFactRelation(input, { mode: "advise", script: join(dir, "missing.py") });
    expect(missing.action).toBe("supersede");
    expect(missing.receipt?.status).toBe("fallback");
    withKind("hang");
    const started = Date.now();
    const hung = await resolveFactRelation(input, { mode: "advise", script: stub, timeoutMs: 500 });
    expect(hung.action).toBe("supersede");
    expect(hung.receipt?.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe("writeRelationReceipt", () => {
  test("stores a row without raw fact text", async () => {
    const db = new Database(":memory:");
    ensureRelationReceiptSchema(db);
    withKind("refine");
    const d = await resolveFactRelation(input, { mode: "shadow", script: stub });
    expect(writeRelationReceipt(db, d, { candidateId: "new-1", source: "inline:test" })).toBe(true);
    expect(writeRelationReceipt(db, { action: "supersede", receipt: null }, { candidateId: null, source: "x" })).toBe(false);
    const rows = db.prepare("SELECT * FROM jev_fact_relation_receipts").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].recommended_relation).toBe("refinement");
    expect(rows[0].effective_action).toBe("supersede");
    expect(rows[0].candidate_id).toBe("new-1");
    expect(rows[0].input_tokens).toBe(400);
    expect(JSON.stringify(rows)).not.toContain("Phoenix");
    expect(JSON.stringify(rows)).not.toContain("Arizona");
    db.close();
  });
});
