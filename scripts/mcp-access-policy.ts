export type MemoryMcpAccessMode = "full" | "context";

export const CONTEXT_TOOL_NAMES = [
  "memory_search",
  "memory_episodes",
  "memory_procedures",
  "cognitive_profile",
] as const;

const CONTEXT_TOOL_SET = new Set<string>(CONTEXT_TOOL_NAMES);

export function resolveMemoryMcpAccessMode(env: NodeJS.ProcessEnv): MemoryMcpAccessMode {
  return env.ZO_MEMORY_MCP_READ_ONLY === "1" ? "context" : "full";
}

export function tokenEnvironmentName(mode: MemoryMcpAccessMode): string {
  return mode === "context" ? "ZOUROBOROS_CONTEXT_MCP_TOKEN" : "ZO_MEMORY_MCP_TOKEN";
}

export function selectExposedTools<T extends { name: string }>(
  tools: readonly T[],
  mode: MemoryMcpAccessMode,
): T[] {
  return mode === "context" ? tools.filter((tool) => CONTEXT_TOOL_SET.has(tool.name)) : [...tools];
}

export function isToolAllowed(name: string, mode: MemoryMcpAccessMode): boolean {
  return mode === "full" || CONTEXT_TOOL_SET.has(name);
}
