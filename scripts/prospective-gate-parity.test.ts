import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureBackendDb } from "./ensure-backend";
import { TRACE_SENTINEL_PATH } from "./trace";

const ROOT = "/home/workspace/Projects/mnemosyne-memory-spike-program/runtime/gate-parity-test";
const MEMORY_DB = resolve(ROOT, "memory.sqlite");
const CONFIG_PATH = resolve(ROOT, "backends.json");
const DISABLED_SCORECARD = resolve(ROOT, "disabled-scorecard.sqlite");
const ENABLED_SCORECARD = resolve(ROOT, "enabled-scorecard.sqlite");
const OBSERVATIONS_DB = resolve(ROOT, "prospective-observations.sqlite");
const TOKEN = "zou-795-disposable-token";

type GateResponse = {
  exit_code: number;
  method: string;
  output: string;
  trace_id: string;
};

async function startGate(enabled: boolean, port: number): Promise<ReturnType<typeof Bun.spawn>> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    ZO_GATE_HOST: "127.0.0.1",
    ZO_GATE_TOKEN: TOKEN,
    ZO_MEMORY_BACKENDS_CONFIG: CONFIG_PATH,
    ZO_SCORECARD_DB: enabled ? ENABLED_SCORECARD : DISABLED_SCORECARD,
  };
  delete env.ZO_MEMORY_PROSPECTIVE_TRACE;
  delete env.ZO_MEMORY_PROSPECTIVE_DB;
  delete env.ZO_MEMORY_PROSPECTIVE_DB_ROOT;
  delete env.ZO_MEMORY_PROSPECTIVE_START_MS;
  delete env.ZO_MEMORY_PROSPECTIVE_END_MS;
  delete env.ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS;
  delete env.ZO_MEMORY_PROSPECTIVE_RETENTION_MS;
  if (enabled) {
    const now = Date.now();
    env.ZO_MEMORY_PROSPECTIVE_TRACE = "1";
    env.ZO_MEMORY_PROSPECTIVE_DB = OBSERVATIONS_DB;
    env.ZO_MEMORY_PROSPECTIVE_DB_ROOT = ROOT;
    env.ZO_MEMORY_PROSPECTIVE_START_MS = String(now - 1_000);
    env.ZO_MEMORY_PROSPECTIVE_END_MS = String(now + 60_000);
    env.ZO_MEMORY_PROSPECTIVE_MAX_RETRIEVALS = "100";
    env.ZO_MEMORY_PROSPECTIVE_RETENTION_MS = "1000";
  }
  const proc = Bun.spawn(
    ["bun", resolve(import.meta.dir, "memory-gate-server.ts")],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return proc;
    } catch {}
    await Bun.sleep(25);
  }
  proc.kill();
  await proc.exited;
  throw new Error("disposable gate did not become healthy");
}

async function queryGate(port: number): Promise<GateResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/gate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "status mnemosyne" }),
  });
  expect(response.status).toBe(200);
  return await response.json() as GateResponse;
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  ensureBackendDb(MEMORY_DB);
  const db = new Database(MEMORY_DB);
  db.prepare(`
    INSERT INTO facts (
      id, persona, entity, key, value, text, category, decay_class,
      importance, source, created_at, last_accessed, confidence, metadata
    ) VALUES (?, 'shared', ?, ?, ?, ?, 'fact', 'active', 1, 'manual', ?, ?, 1, '{}')
  `).run(
    "synthetic-zou-795-fact",
    "project.mnemosyne",
    "status",
    "synthetic parity fixture",
    "mnemosyne status synthetic parity fixture",
    Date.now(),
    Math.floor(Date.now() / 1000),
  );
  db.close();
  writeFileSync(CONFIG_PATH, JSON.stringify({ default: MEMORY_DB, personas: {} }), { mode: 0o600 });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (existsSync(TRACE_SENTINEL_PATH)) rmSync(TRACE_SENTINEL_PATH, { force: true });
});

describe("ZOU-795 disposable gate parity", () => {
  test("keeps gate output identical when prospective tracing is enabled", async () => {
    const basePort = 42000 + Math.floor(Math.random() * 1000);
    const disabled = await startGate(false, basePort);
    const disabledResult = await queryGate(basePort);
    disabled.kill();
    await disabled.exited;

    expect(existsSync(OBSERVATIONS_DB)).toBe(false);
    const disabledScorecard = new Database(DISABLED_SCORECARD, { readonly: true });
    expect((disabledScorecard.prepare("SELECT session_id FROM gate_decisions").get() as { session_id: string | null }).session_id).toBeNull();
    expect((disabledScorecard.prepare("SELECT session_id FROM memory_retrievals").get() as { session_id: string | null }).session_id).toBeNull();
    disabledScorecard.close();

    const enabled = await startGate(true, basePort + 1);
    const enabledResult = await queryGate(basePort + 1);
    enabled.kill();
    await enabled.exited;

    expect({
      exit_code: enabledResult.exit_code,
      method: enabledResult.method,
      output: enabledResult.output,
    }).toEqual({
      exit_code: disabledResult.exit_code,
      method: disabledResult.method,
      output: disabledResult.output,
    });

    const scorecard = new Database(ENABLED_SCORECARD, { readonly: true });
    expect((scorecard.prepare("SELECT session_id FROM gate_decisions").get() as { session_id: string }).session_id).toBe(enabledResult.trace_id);
    expect((scorecard.prepare("SELECT session_id FROM memory_retrievals").get() as { session_id: string }).session_id).toBe(enabledResult.trace_id);
    scorecard.close();

    const observations = new Database(OBSERVATIONS_DB, { readonly: true });
    const retrieval = observations.prepare(`
      SELECT trace_id, method, candidate_ids_available, candidate_count
      FROM prospective_retrievals
    `).get() as Record<string, unknown>;
    expect(retrieval).toEqual({
      trace_id: enabledResult.trace_id,
      method: enabledResult.method,
      candidate_ids_available: 1,
      candidate_count: 1,
    });
    expect((observations.prepare("SELECT fact_id FROM prospective_candidates").get() as { fact_id: string }).fact_id)
      .toBe("synthetic-zou-795-fact");
    observations.close();
  }, 15_000);
});
