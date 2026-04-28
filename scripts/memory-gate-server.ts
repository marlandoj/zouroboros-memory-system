#!/usr/bin/env bun
/**
 * memory-gate-server.ts — Persistent HTTP daemon for memory gate
 *
 * Eliminates per-message bun subprocess spawn overhead by keeping the gate
 * process alive and the configured gate provider ready. Exposes HTTP endpoints for:
 *   POST /gate     — classify message + return memory context
 *   POST /briefing — generate session briefing
 *   GET  /health   — uptime + gate provider status + backend statuses
 *
 * Multi-backend support: personas route to separate DB files via backends.json.
 *
 * Register as a user service:
 *   entrypoint: bun /home/workspace/Skills/zo-memory-system/scripts/memory-gate-server.ts
 *   port: PORT env var (default 7820)
 */

import { detectContinuation } from "./continuation";
import { generate, modelHealthCheck, resolveConfiguredModel } from "./model-client";
import { extractWikilinks } from "./wikilink-utils";
import { getPersonaDomain } from "./domain-map.ts";
import { generateBriefing } from "./session-briefing.ts";
import { logGateDecision } from "./scorecard.ts";
import { ensureBackendDb, getBackendStatus } from "./ensure-backend.ts";
import { existsSync, readFileSync } from "fs";
import { synthesizeAnswer, generateFeedbackFacts } from "./mimir-synthesize.ts";

const MEMORY_SCRIPT = "/home/workspace/Skills/zo-memory-system/scripts/memory.ts";
const MAX_RESULTS = 5;
const PORT = parseInt(process.env.PORT || "7820");
const startedAt = Date.now();

// --- Backend config ---

const BACKENDS_CONFIG_PATH = "/home/workspace/.zo/memory/backends.json";
const DEFAULT_DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

interface BackendsConfig {
  default: string;
  personas: Record<string, string | null>;
}

function loadBackendsConfig(): BackendsConfig {
  try {
    if (existsSync(BACKENDS_CONFIG_PATH)) {
      const raw = readFileSync(BACKENDS_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        default: parsed.default || DEFAULT_DB_PATH,
        personas: parsed.personas || {},
      };
    }
  } catch (err) {
    console.error(`[backends] Failed to load ${BACKENDS_CONFIG_PATH}: ${err}`);
  }
  return { default: DEFAULT_DB_PATH, personas: {} };
}

function resolveBackend(persona?: string): string | null {
  const config = loadBackendsConfig();
  if (!persona) return config.default;
  if (persona in config.personas) {
    return config.personas[persona];
  }
  return config.default;
}

// --- Briefing sentinel (same logic as CLI, in-memory for daemon) ---

const briefingSentinels = new Map<string, number>();
const BRIEFING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isBriefingFresh(persona: string): boolean {
  const ts = briefingSentinels.get(persona);
  if (!ts) return false;
  return Date.now() - ts < BRIEFING_TTL_MS;
}

function markBriefingSentinel(persona: string): void {
  briefingSentinels.set(persona, Date.now());
  for (const [k, v] of briefingSentinels) {
    if (Date.now() - v > BRIEFING_TTL_MS) briefingSentinels.delete(k);
  }
}

// --- Gate provider readiness ---

let gateProviderReady = false;

async function primeGateProvider(): Promise<void> {
  const { provider } = resolveConfiguredModel("gate");
  try {
    const health = await modelHealthCheck(provider);
    gateProviderReady = health.available;
  } catch (err) {
    console.error(`[warm] gate provider readiness failed: ${err}`);
    gateProviderReady = false;
  }
}

primeGateProvider();
setInterval(primeGateProvider, 20 * 60 * 1000);

// --- In-process FTS search (eliminates subprocess spawn for common case) ---

import { Database as Sqlite } from "bun:sqlite";

const dbCache = new Map<string, Sqlite>();
const DEFAULT_DB_FOR_SEARCH = "/home/workspace/.zo/memory/shared-facts.db";

function getSearchDb(dbPath: string): Sqlite {
  let cached = dbCache.get(dbPath);
  if (!cached) {
    cached = new Sqlite(dbPath, { readonly: true });
    try { cached.exec("PRAGMA journal_mode = WAL"); } catch { /* readonly may skip */ }
    dbCache.set(dbPath, cached);
  }
  return cached;
}

function inlineFtsSearch(query: string, dbPath: string, limit: number): string {
  try {
    const db = getSearchDb(dbPath);
    const terms = query.split(/\s+/)
      .map(w => w.replace(/[^\w-]/g, "").trim())
      .filter(w => w.length > 1);
    if (terms.length === 0) return "";
    const ftsQ = terms.map(w => `${w}*`).join(" OR ");
    const rows = db.query(`
      SELECT f.entity, f.key, f.value, f.decay_class, f.category,
             bm25(facts_fts) as score
      FROM facts_fts
      JOIN facts f ON f.rowid = facts_fts.rowid
      WHERE facts_fts MATCH ?
      ORDER BY score LIMIT ?
    `).all(ftsQ, limit) as any[];
    if (rows.length === 0) return "";
    let out = `Found ${rows.length} results:\n\n`;
    for (const r of rows) {
      const v = String(r.value || "").slice(0, 80);
      out += `[${r.decay_class}] ${r.entity}.${r.key || "_"} = ${v}\n`;
      out += `    score: ${(-r.score).toFixed(3)}\n\n`;
    }
    return out.trim();
  } catch (err) {
    console.error(`[inline-fts] error: ${err}`);
    return "";
  }
}

// --- Memory search (in-process FTS fast path + subprocess hybrid fallback) ---

async function searchMemory(keywords: string[], preferExact = false, dbPath?: string): Promise<string> {
  const query = keywords.join(" ");
  const effectiveDb = dbPath || DEFAULT_DB_FOR_SEARCH;

  // Fast path: in-process FTS5 search (~3-10ms vs ~1-3s subprocess)
  const inlineResult = inlineFtsSearch(query, effectiveDb, MAX_RESULTS);
  if (inlineResult && inlineResult.length >= 10) {
    return inlineResult;
  }

  // Fallback for empty FTS or when hybrid is requested: subprocess with HyDE+graph
  if (preferExact) return inlineResult || "No results";

  const env = dbPath ? { ...process.env, ZO_MEMORY_DB: dbPath } : undefined;
  const proc = Bun.spawn(
    ["bun", MEMORY_SCRIPT, "hybrid", query, "--limit", String(MAX_RESULTS)],
    { stdout: "pipe", stderr: "pipe", env }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

async function searchContinuation(message: string, dbPath?: string): Promise<string> {
  const effectiveDb = dbPath || DEFAULT_DB_FOR_SEARCH;

  // Fast path: in-process FTS on the full message (~3-10ms vs ~1-4s subprocess)
  const inlineResult = inlineFtsSearch(message, effectiveDb, MAX_RESULTS);
  if (inlineResult && inlineResult.length >= 10) {
    return `[Continuation Detection] in-process FTS\n${inlineResult}`;
  }

  // Fallback: full continuation pipeline (temporal scoring + HyDE) via subprocess
  const env = dbPath ? { ...process.env, ZO_MEMORY_DB: dbPath } : undefined;
  const proc = Bun.spawn(
    ["bun", MEMORY_SCRIPT, "continuation", message, "--limit", String(MAX_RESULTS)],
    { stdout: "pipe", stderr: "pipe", env }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

// --- Gate classifier ---

interface GateResponse {
  needs_memory: boolean;
  keywords: string[];
  reason: string;
}

async function classifyMemoryNeed(message: string): Promise<GateResponse> {
  const prompt = `You are a classifier. Given a user message, decide if it would benefit from retrieving stored memory/context from previous conversations.

Answer ONLY with valid JSON, no other text.

Rules:
- Favor recall for ongoing or continuation-like work. Missing relevant prior context is worse than retrieving slightly extra context.
- Set "needs_memory": true when the message may plausibly continue prior work, ask for status/progress/results, reference an existing project/document/system, or use pronouns/ellipsis that imply prior context.
- Keep "needs_memory": false for clearly self-contained greetings, trivia, definitions, generic how-to questions, math, or standalone coding prompts.
- "keywords": 2-6 specific search terms extracted from the message (only if needs_memory is true, empty array otherwise). Never include generic words like "hello", "how", "what".
- "reason": one short sentence explaining your decision

Now classify this message:
User: "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

  const result = await generate({ prompt, workload: "gate" });
  const raw = result.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse gate response as JSON: ${raw}`);

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    needs_memory: Boolean(parsed.needs_memory),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    reason: String(parsed.reason || ""),
  };
}

// --- Keyword heuristics (same as CLI) ---

const KEYWORD_MEMORY_PATTERNS = [
  /\b(update|check|status|progress|continue|resume|review|where did we|left off|last time|remind|current|decided?)\b/i,
  /\b(project|system|config|persona|swarm|memory|episode|procedure)\./i,
  /\b(what happened|how is|show me|find)\b.*\b(with|about|for|in|doing|going)\b/i,
  /\b(remind me|what did we|where did we)\b/i,
];

const KEYWORD_SKIP_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|sure|yes|no|bye|goodbye)\s*[!?.]*$/i,
  /^(what is|define|explain|how to|how do you)\s/i,
  /^\d+\s*[\+\-\*\/]\s*\d+/,
  /^good (morning|afternoon|evening)\b/i,
  /^(thanks|thank you) for\b/i,
  /^(write|create|build|implement|generate|code)\b.+\b(function|class|method|script|program|algorithm|component|module|app)\b/i,
];

function extractKeywordsFromMessage(message: string): string[] {
  const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","can","to","of","in","for","on","with","at","by","from","about","how","what","where","when","who","why","which","that","this","it","its","me","my","we","our","you","your","he","she","they","them","and","but","or","if","so","up","out","no","not","just","get","got","let","going","doing"]);
  return message
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// --- Gate handler ---

interface GateRequest {
  message: string;
  persona?: string;
}

interface GateResult {
  exit_code: number; // 0=found, 2=skip, 3=needed-but-empty
  method: string;
  output: string;
  latency_ms: number;
  backend?: string;
}


// --- Mimir 2nd Brain post-processing ---

async function postProcessMimir(
  persona: string | undefined,
  message: string,
  output: string,
  dbPath: string,
): Promise<string> {
  if (persona !== "mimir") return output;
  // Only synthesize if output contains actual memory context (not just briefing)
  const hasMemoryContext = output.includes("[Memory Context") || output.includes("continuation");
  if (!hasMemoryContext) return output;
  try {
    const synthesized = await synthesizeAnswer(message, output, dbPath);
    // Empty string means LLM determined facts are irrelevant to the question
    if (!synthesized) return output;
    // Detached: feedback loop + auto-link (don't block response)
    generateFeedbackFacts(message, synthesized, dbPath)
      .then(ids => { if (ids.length > 0) console.log(`[mimir] Feedback: ${ids.length} facts stored`); })
      .catch(err => console.error(`[mimir] Feedback error: ${err}`));
    return `[Mimir Synthesis]\n${synthesized}`;
  } catch (err) {
    console.error(`[mimir] Synthesis failed, returning raw: ${err}`);
    return output;
  }
}

async function handleGate(req: GateRequest): Promise<GateResult> {
  const start = Date.now();
  const { message, persona } = req;
  let output = "";

  // Resolve backend for this persona
  const dbPath = resolveBackend(persona);

  // Null backend = no memory for this persona — short-circuit
  if (dbPath === null) {
    logGateDecision({ exitCode: 2, method: "null_backend", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
    return { exit_code: 2, method: "null_backend", output: "", latency_ms: Date.now() - start, backend: "null" };
  }

  // Ensure DB exists and is initialized
  ensureBackendDb(dbPath);

  try {
    // Briefing injection (first call per persona per session)
    if (persona && !isBriefingFresh(persona)) {
      try {
        const domain = getPersonaDomain(persona);
        const effectiveDomain = domain === "shared" || domain === "personal" ? undefined : domain;
        const briefingResult = await generateBriefing(persona, effectiveDomain, 500, dbPath);
        if (briefingResult.briefing && !briefingResult.briefing.startsWith("No recent activity")) {
          markBriefingSentinel(persona);
          const parts: string[] = [
            `[Session Briefing — ${persona}${effectiveDomain ? ` (${effectiveDomain})` : ""} — ${briefingResult.latency_ms}ms]`,
            briefingResult.briefing,
          ];
          if (briefingResult.active_items.length > 0) {
            parts.push(`Open items: ${briefingResult.active_items.join("; ")}`);
          }
          if (briefingResult.inherited_facts.length > 0) {
            parts.push(`Cross-persona: ${briefingResult.inherited_facts.join("; ")}`);
          }
          output += parts.join("\n") + "\n\n";
        }
      } catch { /* briefing failure is non-fatal */ }
    }

    // Continuation detection
    const continuation = detectContinuation(message);
    if (continuation.needsMemory) {
      const continuationResults = await searchContinuation(message, dbPath);
      if (continuationResults && !continuationResults.includes("No continuation context found")) {
        output += continuationResults;
        logGateDecision({ exitCode: 0, method: "continuation", memoryFound: true, persona: persona ?? undefined, latencyMs: Date.now() - start });
        output = await postProcessMimir(persona, message, output, dbPath);
        return { exit_code: 0, method: "continuation", output, latency_ms: Date.now() - start, backend: dbPath };
      }
    }

    // Wikilink fast-path
    const wikilinks = extractWikilinks(message);
    if (wikilinks.length > 0) {
      const wlKeywords = wikilinks.map(wl => wl.entity);
      const results = await searchMemory(wlKeywords, true, dbPath);
      if (results && !results.includes("No results") && !results.includes("Found 0 results") && results.length >= 10) {
        output += `[Memory Context — wikilink fast-path: ${wlKeywords.join(", ")}]\n${results}`;
        logGateDecision({ exitCode: 0, method: "wikilink_fast_path", memoryFound: true, persona: persona ?? undefined, latencyMs: Date.now() - start });
        output = await postProcessMimir(persona, message, output, dbPath);
        return { exit_code: 0, method: "wikilink_fast_path", output, latency_ms: Date.now() - start, backend: dbPath };
      }
    }

    // Keyword heuristic
    const hasMemoryKw = KEYWORD_MEMORY_PATTERNS.some(p => p.test(message));
    const hasSkipKw = KEYWORD_SKIP_PATTERNS.some(p => p.test(message));

    if (hasSkipKw && !hasMemoryKw) {
      logGateDecision({ exitCode: 2, method: "keyword_heuristic", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
      return { exit_code: 2, method: "keyword_heuristic", output, latency_ms: Date.now() - start, backend: dbPath };
    }

    if (hasMemoryKw) {
      const keywords = extractKeywordsFromMessage(message);
      if (keywords.length > 0) {
        const results = await searchMemory(keywords, continuation.needsMemory, dbPath);
        if (results && !results.includes("No results") && !results.includes("Found 0 results") && results.length >= 10) {
          output += `[Memory Context — keywords: ${keywords.join(", ")}]\n${results}`;
          logGateDecision({ exitCode: 0, method: "keyword_heuristic", memoryFound: true, persona: persona ?? undefined, latencyMs: Date.now() - start });
          output = await postProcessMimir(persona, message, output, dbPath);
          return { exit_code: 0, method: "keyword_heuristic", output, latency_ms: Date.now() - start, backend: dbPath };
        }
        logGateDecision({ exitCode: 3, method: "keyword_heuristic", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
        return { exit_code: 3, method: "keyword_heuristic", output, latency_ms: Date.now() - start, backend: dbPath };
      }
    }

    // Configured classifier (provider already primed where possible)
    const gate = await classifyMemoryNeed(message);

    if (!gate.needs_memory) {
      logGateDecision({ exitCode: 2, method: "llm_classifier", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
      return { exit_code: 2, method: "llm_classifier", output, latency_ms: Date.now() - start, backend: dbPath };
    }

    if (gate.keywords.length === 0) {
      logGateDecision({ exitCode: 3, method: "llm_classifier", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
      return { exit_code: 3, method: "llm_classifier", output, latency_ms: Date.now() - start, backend: dbPath };
    }

    const results = await searchMemory(gate.keywords, continuation.needsMemory, dbPath);

    if (!results || results.includes("No results") || results.includes("Found 0 results") || results.length < 10) {
      logGateDecision({ exitCode: 3, method: "llm_classifier", memoryFound: false, persona: persona ?? undefined, latencyMs: Date.now() - start });
      return { exit_code: 3, method: "llm_classifier", output, latency_ms: Date.now() - start, backend: dbPath };
    }

    output += `[Memory Context — keywords: ${gate.keywords.join(", ")}]\n${results}`;

    // Fire inline capture detached (same as CLI)
    const INLINE_CAPTURE_SCRIPT = "/home/workspace/Skills/zo-memory-system/scripts/inline-capture.ts";
    const captureSource = `inline:chat/${gate.keywords.join("-")}`;
    const capturePersona = persona || "shared";
    const captureEnv = dbPath ? { ...process.env, ZO_MEMORY_DB: dbPath } : undefined;
    const captureArgs = ["bun", INLINE_CAPTURE_SCRIPT, "--message", message, "--persona", capturePersona, "--source", captureSource];
    const captureProc = Bun.spawn(captureArgs, { stdout: "inherit", stderr: "inherit", env: captureEnv });
    captureProc.unref();

    logGateDecision({ exitCode: 0, method: "llm_classifier", memoryFound: true, persona: persona ?? undefined, latencyMs: Date.now() - start });
    output = await postProcessMimir(persona, message, output, dbPath);
    return { exit_code: 0, method: "llm_classifier", output, latency_ms: Date.now() - start, backend: dbPath };

  } catch (err) {
    console.error(`[gate] Error: ${err}`);
    return { exit_code: 1, method: "error", output: `error: ${err}`, latency_ms: Date.now() - start, backend: dbPath };
  }
}

// --- HTTP Server ---

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      const config = loadBackendsConfig();
      const backends: Record<string, any> = {};
      // Report default backend
      backends["_default"] = getBackendStatus(config.default);
      // Report each persona backend
      for (const [persona, path] of Object.entries(config.personas)) {
        if (path === null) {
          backends[persona] = { exists: false, tables: 0, facts: 0, disabled: true };
        } else {
          backends[persona] = getBackendStatus(path);
        }
      }

      return Response.json({
        status: "ok",
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        gate_provider: resolveConfiguredModel("gate").provider,
        gate_model: resolveConfiguredModel("gate").model,
        gate_provider_ready: gateProviderReady,
        port: PORT,
        backends,
      });
    }

    // Gate endpoint
    if (url.pathname === "/gate" && req.method === "POST") {
      try {
        const body = await req.json() as GateRequest;
        if (!body.message) {
          return Response.json({ error: "missing 'message' field" }, { status: 400 });
        }
        const result = await handleGate(body);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Briefing endpoint
    if (url.pathname === "/briefing" && req.method === "POST") {
      try {
        const body = await req.json() as { persona: string };
        if (!body.persona) {
          return Response.json({ error: "missing 'persona' field" }, { status: 400 });
        }

        const dbPath = resolveBackend(body.persona);
        if (dbPath === null) {
          return Response.json({ exit_code: 2, output: "", latency_ms: 0, backend: "null" });
        }
        ensureBackendDb(dbPath);

        const domain = getPersonaDomain(body.persona);
        const effectiveDomain = domain === "shared" || domain === "personal" ? undefined : domain;
        const result = await generateBriefing(body.persona, effectiveDomain, 500, dbPath);

        if (!result.briefing || result.briefing.startsWith("No recent activity")) {
          return Response.json({ exit_code: 2, output: "", latency_ms: result.latency_ms, backend: dbPath });
        }

        const parts: string[] = [
          `[Session Briefing — ${body.persona}${effectiveDomain ? ` (${effectiveDomain})` : ""} — ${result.latency_ms}ms]`,
          result.briefing,
        ];
        if (result.active_items.length > 0) parts.push(`Open items: ${result.active_items.join("; ")}`);
        if (result.inherited_facts.length > 0) parts.push(`Cross-persona: ${result.inherited_facts.join("; ")}`);

        return Response.json({ exit_code: 0, output: parts.join("\n"), latency_ms: result.latency_ms, backend: dbPath });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[memory-gate-server] Listening on port ${PORT}`);
console.log(`[memory-gate-server] Gate provider priming in progress...`);
console.log(`[memory-gate-server] Backends config: ${BACKENDS_CONFIG_PATH}`);
