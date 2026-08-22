import { describe, expect, test } from "bun:test";
import {
  CONTEXT_TOOL_NAMES,
  isToolAllowed,
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

  test("requires the explicit read-only flag for context mode", () => {
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "1" })).toBe("context");
    expect(resolveMemoryMcpAccessMode({ ZO_MEMORY_MCP_READ_ONLY: "true" })).toBe("full");
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
});
