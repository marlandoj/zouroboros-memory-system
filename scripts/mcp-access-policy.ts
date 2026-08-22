export type MemoryMcpAccessMode = "full" | "context";

const CONTEXT_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FULL_FLAG_VALUES = new Set(["", "0", "false", "no", "off"]);

export const CONTEXT_TOOL_NAMES = [
  "memory_search",
  "memory_episodes",
  "memory_procedures",
  "cognitive_profile",
] as const;

const CONTEXT_TOOL_SET = new Set<string>(CONTEXT_TOOL_NAMES);

export function resolveMemoryMcpAccessMode(env: NodeJS.ProcessEnv): MemoryMcpAccessMode {
  const rawValue = env.ZO_MEMORY_MCP_READ_ONLY;
  if (rawValue === undefined) return "full";

  const value = rawValue.trim().toLowerCase();
  if (CONTEXT_FLAG_VALUES.has(value)) return "context";
  if (FULL_FLAG_VALUES.has(value)) return "full";

  throw new Error(
    `Invalid ZO_MEMORY_MCP_READ_ONLY value: ${JSON.stringify(rawValue)}. ` +
    "Use 1/true/yes/on for context mode or 0/false/no/off for full mode.",
  );
}

export function tokenEnvironmentName(mode: MemoryMcpAccessMode): string {
  return mode === "context" ? "ZOUROBOROS_CONTEXT_MCP_TOKEN" : "ZO_MEMORY_MCP_TOKEN";
}

export function requireBearerToken(env: NodeJS.ProcessEnv, mode: MemoryMcpAccessMode): string {
  const environmentName = tokenEnvironmentName(mode);
  const token = env[environmentName];
  if (!token?.trim()) {
    throw new Error(`${environmentName} is required; refusing to start an unauthenticated HTTP MCP server.`);
  }
  return token;
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
