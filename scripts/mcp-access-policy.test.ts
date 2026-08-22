import { describe, expect, test } from "bun:test";
import {
  CONTEXT_TOOL_NAMES,
  isToolAllowed,
  requireBearerToken,
  resolveMemoryMcpAccessMode,
  selectExposedTools,
  tokenEnvironmentName,
} from "./mcp-access-policy";

const allTools = [
  "memory_search",
  "memory_store",
  "memory_episodes",
  "memory_procedures",
  "cognitive_profile",
  "memory_delete",
  "memory_prune",
].map((name) => ({ name }));

describe("memory MCP access policy", () => {
  test("defaults to full mode for backward compatibility", () => {
    expect(resolveMemoryMcpAccessMode({})).toBe("full");
    expect(selectExposedTools(allTools, "full")).toEqual(allTools);
  });

  test("accepts standard truthy values for context mode", () => {
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "1" })).toBe("context");
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "true" })).toBe("context");
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "YES" })).toBe("context");
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "on" })).toBe("context");
  });

  test("accepts explicit false values and rejects ambiguous mode values", () => {
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "0" })).toBe("full");
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "false" })).toBe("full");
    expect(() => resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "ture" })).toThrow(
      "Invalid ZO_MEMORY_MCP_READ_ONLY value",
    );
  });

  test("context mode advertises only the approved read tools", () => {
    expect(selectExposedTools(allTools, "context").map((tool) => tool.name)).toEqual([...CONTEXT_TOOL_NAMES]);
  });

  test("context mode denies all mutation tools before dispatch", () => {
    for (const name of CONTEXT_TOOL_NAMES) expect(isToolAllowed(name, "context")).toBeTrue();
    for (const name of ["memory_store", "memory_delete", "memory_prune", "unknown"]) {
      expect(isToolAllowed(name, "context")).toBeFalse();
    }
  });

  test("context and full servers use separate credential names", () => {
    expect(tokenEnvironmentName("context")).toBe("ZOUROBOROS_CONTEXT_MCP_TOKEN");
    expect(tokenEnvironmentName("full")).toBe("ZO_MEMORY_MCP_TOKEN");
  });

  test("both HTTP modes require their selected server credential", () => {
    expect(requireBearerToken({ ZOUROBOROS_CONTEXT_MCP_TOKEN: "context-token" }, "context")).toBe("context-token");
    expect(requireBearerToken({ ZO_MEMORY_MCP_TOKEN: "full-token" }, "full")).toBe("full-token");
    expect(() => requireBearerToken({}, "context")).toThrow("ZOUROBOROS_CONTEXT_MCP_TOKEN is required");
    expect(() => requireBearerToken({}, "full")).toThrow("ZO_MEMORY_MCP_TOKEN is required");
  });
});
