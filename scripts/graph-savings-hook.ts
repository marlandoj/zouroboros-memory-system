#!/usr/bin/env bun
/**
 * PostToolUse hook — graph-first retrieval savings telemetry.
 *
 * Fires on codebase-memory MCP retrieval calls. For each qualifying query it
 * records the NET context tokens avoided versus a *capped, conservative*
 * targeted-file-read alternative, appending one JSONL line that the Costs tab
 * (`/api/zouroboros/costs` -> avoided.graphRetrieval) aggregates.
 *
 * Design constraints (the metric must not be Goodhart-able):
 *   - Baselines are a disciplined targeted-read alternative (grep + read a
 *     couple of spans), NOT a whole-repo / whole-file dump. Deliberately modest.
 *   - savings = max(0, baseline - actualResultTokens): the query result that
 *     actually entered context is subtracted, so the figure is NET avoided.
 *   - Pure telemetry: never writes to cost_ledger, never blocks the tool call,
 *     always exits 0. A spend ledger logs money spent; this logs money not spent.
 */
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Canonical shared memory dir (same root the Costs API reads — scorecard.db,
// model-call-log.jsonl, shared-facts.db all live here). Hardcoded absolute, NOT
// $HOME/.zo: the hook runs inside Claude Code where $HOME=/root, which would
// strand the log in a stray /root/.zo the dashboard route never reads.
const LOG = "/home/workspace/.zo/memory/graph-retrieval-log.jsonl";

// Capped baseline = input tokens a disciplined targeted-read alternative would
// have pulled into context to answer the same structural question. Intentionally
// conservative (a couple of spans across 1-2 files), not "read the whole file".
const BASELINE: Record<string, number> = {
  search_code: 1500, // ~2 grep+read cycles to locate a symbol
  search_graph: 1500,
  trace_path: 3000, // tracing callers/impact reads across several files
  query_graph: 2500, // multi-hop dependency question
  get_architecture: 5000, // replaces broad exploratory reads of the module map
};

function shortTool(name: string): string | null {
  const m = name.match(/^mcp__codebase-memory__(.+)$/);
  if (!m) return null;
  return m[1] in BASELINE ? m[1] : null;
}

async function main() {
  let raw = "";
  for await (const chunk of Bun.stdin.stream()) raw += Buffer.from(chunk).toString();
  if (!raw.trim()) return;

  const evt = JSON.parse(raw);
  const tool = shortTool(String(evt.tool_name || ""));
  if (!tool) return; // not a tracked retrieval tool — silent no-op

  // Tokens the query result put into context (the real cost we net out).
  const respStr =
    typeof evt.tool_response === "string"
      ? evt.tool_response
      : JSON.stringify(evt.tool_response ?? "");
  const actualTokens = Math.ceil(respStr.length / 4);

  const baseline = BASELINE[tool];
  const savings = Math.max(0, baseline - actualTokens);

  const row = {
    ts: Date.now(),
    tool,
    session: evt.session_id ?? null,
    actual_tokens: actualTokens,
    baseline_tokens: baseline,
    savings_tokens: savings,
  };

  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(row) + "\n");
}

main()
  .catch(() => {}) // never block or fail the tool call
  .finally(() => process.exit(0));
