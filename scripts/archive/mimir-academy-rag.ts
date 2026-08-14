#!/usr/bin/env bun
/**
 * mimir-academy-rag.ts — code-graph enrichment for the Mimir Academy instructor.
 *
 * Phase 2 of the codebase-memory-wiring project. Gives the indexed Skills/ graph
 * four more readers so Mimir teaches against REAL, current skill code instead of
 * hallucinating skills that were renamed or removed:
 *
 *   2b dependency-aware paths   → trace_path        (buildInstructorDigest)
 *   2c pre-flight concept check → get_architecture  (graphStats, in the digest)
 *   2d find-the-code            → search_graph       (buildMimirLessonContext)
 *   2e skill health            → detect_changes     (skillHealth, in the digest)
 *
 * (2a curriculum sync via search_code is already served by code-rag's
 * buildCodeContext on the session briefing — no separate caller needed.)
 *
 * Same non-fatal discipline as code-rag.ts: every binary-CLI call returns
 * null/[] on a missing binary, timeout, non-zero exit, or parse error. The
 * instructor surface must never break because the graph is unreachable.
 */
import { cliCall, changedSourceFiles, extractKeywords } from "./code-rag.ts";

export const SKILLS_PROJECT = "home-workspace-Skills";

// --- 2d: find-the-code via the semantic (bm25) graph search ------------------

export interface GraphHit {
  name: string;
  file: string;
  start: number;
  end: number;
  label: string;
}

/** search_graph (bm25) — better than literal grep for natural-language topics. */
export function findTheCode(query: string, project = SKILLS_PROJECT, limit = 3): GraphHit[] {
  const data = cliCall("search_graph", { project, query, limit: limit * 2 });
  const out: GraphHit[] = [];
  for (const r of (data?.results ?? [])) {
    const file = r.file_path || r.file || "";
    if (!file) continue;
    out.push({
      name: r.name || r.qualified_name || "?",
      file,
      start: r.start_line ?? 0,
      end: r.end_line ?? 0,
      label: r.label || "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

// --- 2c: pre-flight — graph stats + per-skill existence ----------------------

/** get_architecture — project-level node/edge counts (also the data-prereq probe). */
export function graphStats(project = SKILLS_PROJECT): { nodes: number; edges: number } | null {
  const data = cliCall("get_architecture", { project });
  if (!data) return null;
  return { nodes: data.total_nodes ?? 0, edges: data.total_edges ?? 0 };
}

/** True iff the named skill directory is present in the graph (renamed/removed → false). */
export function skillExists(skillName: string, project = SKILLS_PROJECT): boolean {
  const safe = skillName.replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return false;
  const hits = findTheCode(safe, project, 8);
  const re = new RegExp(`(^|/)${safe}/`, "i");
  return hits.some((h) => re.test(h.file));
}

// --- 2b: dependency chain via trace_path -------------------------------------

export interface TraceHop {
  name: string;
  hop: number;
}

// Generic names whose call graphs fan out to half the repo — useless as a
// dependency spotlight, and noise if traced.
const GENERIC_FN = new Set([
  "log", "main", "init", "run", "cli", "die", "teardown", "setup", "emit",
  "apply", "correct", "validate", "showHelp", "help", "start", "stop", "fetch",
  "handler", "default", "exec", "wrap", "wrapCli", "?",
]);

export function tracePath(
  functionName: string,
  direction: "inbound" | "outbound" = "inbound",
  depth = 1,
  project = SKILLS_PROJECT,
  cap = 5,
): TraceHop[] {
  const data = cliCall("trace_path", { project, function_name: functionName, direction, depth });
  const arr = (data?.callers ?? data?.callees ?? []) as any[];
  const out: TraceHop[] = [];
  const seen = new Set<string>();
  for (const c of arr) {
    const name = c.name || c.qualified_name || "?";
    // file-path-ish names (contain "/") are module nodes, not callers — skip.
    if (name.includes("/") || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, hop: c.hop ?? 0 });
    if (out.length >= cap) break;
  }
  return out;
}

// --- 2e: skill health — recently-changed skill directories -------------------

/** detect_changes folded down to distinct top-level skill dirs (noise pre-filtered). */
export function skillHealth(limit = 8): string[] {
  const files = changedSourceFiles(SKILLS_PROJECT, 80);
  const skills: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const top = f.split("/")[0];
    if (!top || top.includes(".") || seen.has(top)) continue;
    seen.add(top);
    skills.push(top);
    if (skills.length >= limit) break;
  }
  return skills;
}

// --- Mimir gate enrichment (live persona path) -------------------------------

/**
 * Compact `[Mimir Lesson Context]` block for a learner question — real Skills/
 * files via semantic graph search, framed so Mimir cites them instead of
 * inventing skills. Returns null when nothing relevant is found.
 */
export async function buildMimirLessonContext(topic: string): Promise<string | null> {
  const kws = extractKeywords(topic, 4);
  if (kws.length === 0) return null;
  const hits = findTheCode(kws.join(" "), SKILLS_PROJECT, 3);
  if (hits.length === 0) return null;
  const lines = hits.map((h) => `  • ${h.file}:${h.start}-${h.end} — ${h.name}${h.label ? ` (${h.label})` : ""}`);
  return [
    `[Mimir Lesson Context — verified Skills/ code for: ${kws.join(", ")}]`,
    ...lines,
    `  (these are real files in the live codebase-memory graph — cite them; do not invent skills)`,
  ].join("\n");
}

// --- Instructor digest (scheduled / instructor-view caller) ------------------

/**
 * `[Mimir Academy — Skill Health Digest]`: index stats (get_architecture),
 * skills changed since last index (detect_changes), and a dependency map for
 * one changed skill's key function (trace_path). The scheduled caller for 2b/2e.
 */
export function buildInstructorDigest(): string {
  const lines: string[] = ["[Mimir Academy — Skill Health Digest]"];

  const stats = graphStats();
  if (stats) {
    lines.push(`Skills graph: ${stats.nodes.toLocaleString()} nodes / ${stats.edges.toLocaleString()} edges indexed.`);
  } else {
    lines.push("Skills graph: UNREACHABLE — index may be stale or the binary is missing.");
  }

  const changed = skillHealth(8);
  if (changed.length === 0) {
    lines.push("Skills updated this week: none detected since last index.");
    return lines.join("\n");
  }
  lines.push(`Skills updated this week: ${changed.join(", ")}`);

  // Dependency spotlight: trace inbound callers of a representative, non-generic
  // function that actually lives inside a changed skill, so the digest teaches
  // how the change ripples. Scan changed skills until one yields a real chain.
  for (const skill of changed) {
    const fn = pickSpotlightFn(skill);
    if (!fn) continue;
    const callers = tracePath(fn, "inbound", 1, SKILLS_PROJECT, 5);
    if (callers.length > 0) {
      const chain = callers.map((c) => c.name).join(", ");
      lines.push(`Dependency spotlight: ${skill}.${fn}() is called by ${chain}`);
      break;
    }
  }

  return lines.join("\n");
}

/** A named Function/Method physically under `<skill>/` whose name isn't generic. */
function pickSpotlightFn(skill: string): string | null {
  const safe = skill.replace(/[^a-z0-9_-]/gi, "");
  const re = new RegExp(`(^|/)${safe}/`, "i");
  for (const h of findTheCode(skill, SKILLS_PROJECT, 12)) {
    if (!re.test(h.file)) continue;
    if (h.label && h.label !== "Function" && h.label !== "Method") continue;
    if (h.name && h.name !== "?" && !h.name.includes("/") && !GENERIC_FN.has(h.name) && h.name.length > 3) {
      return h.name;
    }
  }
  return null;
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === "context") {
      const topic = rest.join(" ") || "consensus gate";
      const block = await buildMimirLessonContext(topic);
      console.log(block ?? "(no lesson context — graph unreachable or no match)");
    } else if (cmd === "digest") {
      console.log(buildInstructorDigest());
    } else if (cmd === "exists") {
      const skill = rest[0] || "consensus-gate";
      console.log(`${skill}: ${skillExists(skill) ? "EXISTS" : "NOT FOUND"} in graph`);
    } else if (cmd === "trace") {
      console.log(JSON.stringify(tracePath(rest[0] || "computeConsensus", "inbound", 2), null, 2));
    } else if (cmd === "find") {
      console.log(JSON.stringify(findTheCode(rest.join(" ") || "consensus gate"), null, 2));
    } else {
      console.error("Usage: bun mimir-academy-rag.ts <context|digest|exists|trace|find> [args...]");
      process.exit(1);
    }
  })();
}
