import { describe, test, expect, afterEach } from "bun:test";
import { generateTraceId, writeTraceId, readTraceId, TRACE_SENTINEL_PATH } from "./trace.js";
import { unlinkSync, existsSync } from "fs";

afterEach(() => {
  if (existsSync(TRACE_SENTINEL_PATH)) unlinkSync(TRACE_SENTINEL_PATH);
});

describe("Single-Trace Observability — trace primitive", () => {
  test("generateTraceId returns UUID4 format", () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("each call returns a unique id", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateTraceId()));
    expect(ids.size).toBe(20);
  });

  test("writeTraceId + readTraceId round-trips the sentinel", () => {
    const id = generateTraceId();
    writeTraceId(id);
    expect(readTraceId()).toBe(id);
  });

  test("readTraceId returns null when sentinel absent", () => {
    expect(readTraceId()).toBeNull();
  });

  test("writeTraceId overwrites previous sentinel", () => {
    writeTraceId("first-id");
    const second = generateTraceId();
    writeTraceId(second);
    expect(readTraceId()).toBe(second);
  });
});

describe("Single-Trace Observability — ZO_TRACE_ID env propagation", () => {
  test("ZO_TRACE_ID set in env is readable in subprocess", async () => {
    const traceId = generateTraceId();
    const proc = Bun.spawn(
      ["bun", "-e", "console.log(process.env.ZO_TRACE_ID || 'missing')"],
      {
        env: { ...process.env, ZO_TRACE_ID: traceId },
        stdout: "pipe",
      }
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toBe(traceId);
  });
});
