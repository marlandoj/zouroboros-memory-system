#!/usr/bin/env bun
/**
 * code-rag.ts — read-only code-context enrichment from the codebase-memory graph.
 *
 * Wraps the DeusData/codebase-memory-mcp binary CLI (search_code / detect_changes /
 * trace_path) so shell- and daemon-context callers (the memory gate, Mimir
 * automation) can surface real source intelligence without MCP-tool access.
 *
 * Discipline mirrors agent-introspect's architecture enrichment: every call is
 * fully non-fatal. A missing binary, timeout, non-zero exit, or parse error
 * yields null/[] rather than throwing — the briefing must never break because the
 * graph is unreachable.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const CODEBASE_MEMORY_BIN =
  process.env.CODEBASE_MEMORY_BIN ??
  "/home/workspace/Integrations/codebase-memory-mcp/bin/codebase-memory-mcp";

export const DEFAULT_PROJECTS = ["home-workspace-Skills", "home-workspace-packages"];
const DEFAULT_TIMEOUT_MS = 6000;
const TOP_N = 3;

// Source extensions worth surfacing; everything else (caches, dbs, trajectories,
// lockfiles) is noise that detect_changes returns unfiltered.
const SOURCE_RE = /\.(ts|tsx|js|jsx|py|sh|md|json)$/i;
const NOISE_RE = /(__pycache__|\.db(-wal|-shm)?$|\.cache|node_modules|trajectories\/|\.pyc$)/i;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "it", "its", "as", "at", "by", "from", "into", "via", "per", "run",
  "running", "build", "building", "wire", "wiring", "add", "adding", "fix",
  "fixing", "update", "updating", "complete", "completed", "pending", "status",
  "phase", "task", "project", "still", "now", "next", "then", "your", "you",
  // generic question / filler words that leak from "One Thing" prompts
  "what", "would", "like", "work", "working", "want", "should", "already",
  "need", "needs", "keep", "make", "made", "have", "has", "will", "can",
  "could", "recreated", "references", "utilize", "recent", "activity", "raw",
  "context", "conversation", "success", "resolved", "stored", "facts", "skipped",
  "commitment", "bug", "must", "when", "where", "which", "while", "about",
]);

/** Extract up to `max` salient keywords from free-text briefing context. */
export function extractKeywords(text: string, max = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9_]+/)) {
    const w = raw.trim();
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Run one binary CLI subcommand; returns parsed JSON or null on any failure. */
export function cliCall(
  command: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): any | null {
  if (!existsSync(CODEBASE_MEMORY_BIN)) return null;
  let r;
  try {
    r = spawnSync(CODEBASE_MEMORY_BIN, ["cli", command, JSON.stringify(args)], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (r.status !== 0 && !r.stdout) return null;
  const out = (r.stdout || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    // Tolerate a stray init/log line before the JSON body.
    for (const line of out.split("\n").reverse()) {
      const s = line.trim();
      if (s.startsWith("{")) {
        try {
          return JSON.parse(s);
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}

export interface CodeHit {
  name: string;
  file: string;
  start: number;
  end: number;
  project: string;
}

/**
 * search_code across projects for one or more patterns; merged, de-duped,
 * source-filtered top-N. NOTE: the binary keys on `pattern` (a literal grep
 * substring — no regex alternation), so each keyword is searched individually
 * and the results merged in keyword-priority order.
 */
export function searchCode(
  patterns: string | string[],
  projects = DEFAULT_PROJECTS,
  limit = TOP_N,
): CodeHit[] {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
  const hits: CodeHit[] = [];
  const seen = new Set<string>();
  for (const pattern of list) {
    for (const project of projects) {
      const data = cliCall("search_code", { project, pattern, limit: limit * 2 });
      for (const res of (data?.results ?? [])) {
        const file = res.file || res.file_path || "";
        if (!file || !SOURCE_RE.test(file) || NOISE_RE.test(file)) continue;
        const name = res.node || res.name || res.qualified_name || "?";
        const key = `${project}:${file}:${res.start_line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          name,
          file,
          start: res.start_line ?? 0,
          end: res.end_line ?? 0,
          project,
        });
      }
    }
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

/**
 * Build a `[Code Context]` block from briefing seed text. Returns null when the
 * graph is unreachable or nothing relevant is found — caller simply omits it.
 */
export async function buildCodeContext(
  seedText: string,
  opts: { projects?: string[]; topN?: number } = {},
): Promise<string | null> {
  const keywords = extractKeywords(seedText);
  if (keywords.length === 0) return null;
  const hits = searchCode(keywords, opts.projects ?? DEFAULT_PROJECTS, opts.topN ?? TOP_N);
  if (hits.length === 0) return null;
  const lines = hits.map((h) => {
    const proj = h.project.replace(/^home-workspace-/, "");
    return `  • ${proj}/${h.file}:${h.start}-${h.end} — ${h.name}`;
  });
  return [`[Code Context — graph match on: ${keywords.slice(0, 4).join(", ")}]`, ...lines].join("\n");
}

/** Recently-changed source files for a project (noise-filtered). */
export function changedSourceFiles(project: string, limit = 10): string[] {
  const data = cliCall("detect_changes", { project });
  const files = (data?.changed_files ?? []) as string[];
  return files.filter((f) => SOURCE_RE.test(f) && !NOISE_RE.test(f)).slice(0, limit);
}

// --- CLI for smoke testing ---------------------------------------------------
if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === "context") {
      const seed = rest.join(" ") || "memory gate consensus";
      const block = await buildCodeContext(seed);
      console.log(block ?? "(no code context — graph unreachable or no match)");
    } else if (cmd === "changed") {
      const project = rest[0] || "home-workspace-Skills";
      console.log(changedSourceFiles(project).join("\n") || "(none)");
    } else if (cmd === "search") {
      console.log(JSON.stringify(searchCode(rest.join(" ") || "memory"), null, 2));
    } else {
      console.error("Usage: bun code-rag.ts <context|changed|search> [args...]");
      process.exit(1);
    }
  })();
}
