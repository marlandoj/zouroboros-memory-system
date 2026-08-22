import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CONTEXT_TOOL_NAMES } from "./mcp-access-policy";

const SCRIPT = join(import.meta.dir, "mcp-server-http.ts");
const CONTEXT_PORT = 48531;
const FULL_PORT = 48532;
const MISSING_TOKEN_PORT = 48533;
const CONTEXT_TOKEN = "context-test-token";
const FULL_TOKEN = "full-test-token";
const tempRoot = mkdtempSync(join(tmpdir(), "zouroboros-context-mcp-"));
const dbPath = join(tempRoot, "memory.db");

let contextProcess: ReturnType<typeof Bun.spawn>;
let fullProcess: ReturnType<typeof Bun.spawn>;

function databaseDigest(): string {
  return createHash("sha256").update(readFileSync(dbPath)).digest("hex");
}

function spawnServer(port: number, mode: "context" | "full") {
  const env = {
    ...process.env,
    PORT: String(port),
    ZO_MEMORY_DB: dbPath,
    ZO_MEMORY_MCP_READ_ONLY: mode === "context" ? "true" : "false",
    ZOUROBOROS_CONTEXT_MCP_TOKEN: mode === "context" ? CONTEXT_TOKEN : "",
    ZO_MEMORY_MCP_TOKEN: mode === "full" ? FULL_TOKEN : "",
  };
  return Bun.spawn(["bun", SCRIPT], {
    cwd: import.meta.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function spawnContextServerWithoutToken() {
  const {
    ZOUROBOROS_CONTEXT_MCP_TOKEN: _contextToken,
    ZO_MEMORY_MCP_TOKEN: _fullToken,
    ...inheritedEnvironment
  } = process.env;
  const env = {
    ...inheritedEnvironment,
    HOME: tempRoot,
    PORT: String(MISSING_TOKEN_PORT),
    ZO_MEMORY_DB: dbPath,
    ZO_MEMORY_MCP_READ_ONLY: "true",
  };
  return Bun.spawn(["bun", SCRIPT], {
    cwd: import.meta.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHealth(port: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`MCP server on port ${port} did not become healthy`);
}

function parseMcpBody(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

async function mcpRequest(
  port: number,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; payload: any }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? parseMcpBody(text) : null };
}

async function initialize(port: number, token: string): Promise<string | undefined> {
  const { response, payload } = await mcpRequest(port, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "context-policy-test", version: "1.0.0" },
    },
  });
  expect(response.status).toBe(200);
  expect(payload.result.serverInfo.name).toBeTruthy();
  return response.headers.get("mcp-session-id") ?? undefined;
}

beforeAll(async () => {
  const database = new Database(dbPath);
  database.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  database.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, source, created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "context-fact",
    "shared",
    "project.context-mcp",
    "status",
    "read path verified",
    "context fixture searchable read path verified",
    "project",
    "stable",
    "held-out-test",
    now * 1000,
    now,
  );
  database.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
  database.prepare("INSERT INTO episodes (id, summary, outcome, happened_at) VALUES (?, ?, ?, ?)")
    .run("context-episode", "Context MCP read verification completed", "success", now);
  database.prepare("INSERT INTO episode_entities (episode_id, entity) VALUES (?, ?)")
    .run("context-episode", "project.context-mcp");
  database.prepare(`
    INSERT INTO procedures (id, name, version, steps, success_count, failure_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "context-procedure",
    "context-read-verification",
    1,
    JSON.stringify([{ executor: "codex", taskPattern: "verify context reads", timeoutSeconds: 60 }]),
    1,
    0,
  );
  database.close();
  mkdirSync(join(tempRoot, ".swarm"), { recursive: true });
  writeFileSync(join(tempRoot, ".swarm", "executor-history.json"), JSON.stringify({
    "codex:verification": {
      attempts: 1,
      successes: 1,
      avgDurationMs: 1000,
      recent_episode_ids: ["context-episode"],
      failure_patterns: [],
      entity_affinities: { "project.context-mcp": 1 },
    },
  }));
  contextProcess = spawnServer(CONTEXT_PORT, "context");
  fullProcess = spawnServer(FULL_PORT, "full");
  await Promise.all([waitForHealth(CONTEXT_PORT), waitForHealth(FULL_PORT)]);
});

afterAll(async () => {
  contextProcess?.kill();
  fullProcess?.kill();
  await Promise.all([contextProcess?.exited, fullProcess?.exited]);
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("HTTP memory MCP access isolation", () => {
  test("rejects a request without an Authorization header", async () => {
    const response = await fetch(`http://127.0.0.1:${CONTEXT_PORT}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  test("refuses to start when the context server credential is absent", async () => {
    const process = spawnContextServerWithoutToken();
    const stderrPromise = new Response(process.stderr).text();
    const exitCode = await process.exited;
    const stderr = await stderrPromise;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ZOUROBOROS_CONTEXT_MCP_TOKEN is required");
    await expect(fetch(`http://127.0.0.1:${MISSING_TOKEN_PORT}/health`)).rejects.toThrow();
  });

  test("rejects an incorrect or retired credential", async () => {
    const { response } = await mcpRequest(
      CONTEXT_PORT,
      "retired-legacy-token",
      { jsonrpc: "2.0", id: 10, method: "initialize", params: {} },
    );
    expect(response.status).toBe(401);
  });

  test("context mode advertises exactly the approved read tools", async () => {
    const health = await waitForHealth(CONTEXT_PORT);
    expect(health.accessMode).toBe("context");
    expect(health.tools).toEqual([...CONTEXT_TOOL_NAMES]);

    const sessionId = await initialize(CONTEXT_PORT, CONTEXT_TOKEN);
    const { payload } = await mcpRequest(
      CONTEXT_PORT,
      CONTEXT_TOKEN,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...CONTEXT_TOOL_NAMES]);
  });

  test("context mode rejects a direct write-tool call and leaves SQLite unchanged", async () => {
    const before = databaseDigest();
    const sessionId = await initialize(CONTEXT_PORT, CONTEXT_TOKEN);
    const { payload } = await mcpRequest(
      CONTEXT_PORT,
      CONTEXT_TOKEN,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memory_store", arguments: { entity: "test", value: "must not persist" } },
      },
      sessionId,
    );
    expect(payload.result.isError).toBeTrue();
    expect(payload.result.content[0].text).toContain("not available in context mode");
    expect(databaseDigest()).toBe(before);
  });

  test("all approved context tools execute successfully without changing SQLite", async () => {
    const before = databaseDigest();
    const calls = [
      { name: "memory_search", arguments: { query: "context" }, expected: "read path verified" },
      { name: "memory_episodes", arguments: { entity: "project.context-mcp" }, expected: "Context MCP read verification completed" },
      { name: "memory_procedures", arguments: { name: "context-read-verification" }, expected: "Procedure: context-read-verification v1" },
      { name: "cognitive_profile", arguments: { executor_id: "codex" }, expected: "Cognitive profile for codex" },
    ];

    for (const [index, call] of calls.entries()) {
      const { response, payload } = await mcpRequest(CONTEXT_PORT, CONTEXT_TOKEN, {
        jsonrpc: "2.0",
        id: 20 + index,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments },
      });
      expect(response.status).toBe(200);
      expect(payload.result.isError).not.toBeTrue();
      expect(payload.result.content[0].text).toContain(call.expected);
    }

    expect(databaseDigest()).toBe(before);
  });

  test("full mode retains the existing tool surface", async () => {
    const health = await waitForHealth(FULL_PORT);
    expect(health.accessMode).toBe("full");
    expect(health.tools).toContain("memory_store");
    expect(health.tools).toContain("memory_delete");
    expect(health.tools).toContain("memory_prune");
  });
});
