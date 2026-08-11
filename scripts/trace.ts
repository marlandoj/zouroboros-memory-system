/**
 * trace.ts — Single-trace observability primitive.
 *
 * Generates a per-request UUID4 trace_id. The gate propagates it via the
 * ZO_TRACE_ID env var to child processes (fact extractor, episodes, swarm
 * sessions), and writes a sentinel at TRACE_SENTINEL_PATH for shell/CLI
 * tools that aren't spawned with env inheritance.
 *
 * Cycle A: facts.metadata.trace_id (env-propagated).
 * Cycle B: episodes.metadata.trace_id and swarm_sessions.metadata.trace_id
 * (env-propagated through Bun.spawn with explicit env: { ...process.env }).
 */

import { writeFileSync, readFileSync } from "fs";

export const TRACE_SENTINEL_PATH = "/tmp/zo-trace-id";

export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function writeTraceId(traceId: string): void {
  try {
    writeFileSync(TRACE_SENTINEL_PATH, traceId, "utf-8");
  } catch { /* non-fatal — sentinel is best-effort */ }
}

export function readTraceId(): string | null {
  try {
    const val = readFileSync(TRACE_SENTINEL_PATH, "utf-8").trim();
    return val || null;
  } catch {
    return null;
  }
}
