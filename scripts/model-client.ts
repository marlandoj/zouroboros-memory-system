// =============================================================================
// model-client.ts — Unified model provider abstraction
//
// Replaces direct provider calls with a clean interface that routes to OpenAI
// or Anthropic based on env vars.
//
// Usage:
//   import { generate, embeddings, modelHealthCheck } from "./model-client";
//
//   const { content, latency_ms } = await generate({
//     prompt: "Hello world",
//     workload: "gate",
//   });
//
// Env vars by workload (all optional — defaults to OpenAI unless overridden):
//   ZO_MODEL_GATE         → memory gate classifier
//   ZO_MODEL_HYDE         → HyDE query expansion
//   ZO_MODEL_EXTRACTION   → fact extraction
//   ZO_MODEL_SUMMARIZATION → episode summarization
//   ZO_MODEL_BRIEFING     → session briefing
//   ZO_MODEL_CAPTURE      → inline capture
//   ZO_MODEL_CONVERSATION  → conversation capture
//   ZO_MODEL_RESEARCH      → deep-research planning and synthesis
//   ZO_MODEL_EMBEDDING    → embedding model
//
// Model spec format: "provider:model-id"
//   openai:gpt-4o-mini    → OpenAI
//   anthropic:haiku        → Anthropic (via Zo OAuth)
//
//   Bare names default to a provider inferred from the model id.
//
// Cost tracking: every call returns { content, latency_ms, provider, model, cost_usd }
// =============================================================================

import {
  callMoaModel,
  DEFAULT_PRODUCTION_MOA_LINEUP,
  resolveProductionMoaLineup,
} from "../../consensus-gate/scripts/moa-runtime";

export type Provider = "openai" | "anthropic" | "openrouter" | "opencode" | "moa";
export type Workload =
  | "gate" | "hyde" | "crag" | "extraction"
  | "summarization" | "briefing"
  | "capture" | "conversation" | "research" | "embedding";

export interface GenerateOptions {
  prompt: string;
  system?: string;
  workload: Workload;
  model?: string;         // overrides ZO_MODEL_<WORKLOAD>
  temperature?: number;
  maxTokens?: number;
  json?: boolean;          // if true, request structured JSON response
  max_age?: number;        // Anthropic max_age parameter
  signal?: AbortSignal;
}

export interface GenerateResult {
  content: string;
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  usage?: { input_tokens: number; output_tokens: number };
  moa?: {
    lineup_source: "env" | "dynamic" | "fallback" | "fallback-after-failure";
    proposers_requested: string[];
    proposers_used: string[];
    aggregator_requested: string;
    aggregator_used: string;
  };
}

export interface EmbedResult {
  embedding: number[];
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  error?: string;
}

export interface HealthResult {
  available: boolean;
  latency_ms: number;
  error?: string; cost_usd?: number;
}

// ─── Workload defaults ────────────────────────────────────────────────────────

const WORKLOAD_TEMP: Record<Workload, number> = {
  gate: 0.1, hyde: 0.3, crag: 0.3, extraction: 0.2,
  summarization: 0.4, briefing: 0.5,
  capture: 0.4, conversation: 0.4, research: 0.3, embedding: 0.0,
};

const WORKLOAD_MAX_TOKENS: Record<Workload, number> = {
  gate: 150, hyde: 200, crag: 200, extraction: 600,
  summarization: 800, briefing: 400,
  capture: 600, conversation: 600, research: 8192, embedding: 2048,
};

const OPENAI_RATES_PER_1M: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function calculateOpenAICostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = OPENAI_RATES_PER_1M[model] ?? OPENAI_RATES_PER_1M["gpt-4o-mini"];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
}

// ─── Model spec parser ────────────────────────────────────────────────────────

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "openrouter", "opencode", "moa"];

const KNOWN_OPENAI_MODELS = new Set([
  "gpt-4o", "gpt-4o-mini", "gpt-4o-large", "gpt-4-turbo", "gpt-4",
  "gpt-3.5-turbo", "gpt-3.5-turbo-16k",
  "text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002",
  "o1", "o1-mini", "o1-preview", "o3-mini",
]);

function parseModelSpec(spec: string): { provider: Provider; model: string } {
  if (!spec || typeof spec !== "string") return { provider: "openai", model: "gpt-4o-mini" };
  const colon = spec.indexOf(":");
  if (colon < 0) {
    // Bare name — check if it's a known OpenAI model
    const base = spec.split("/").pop() || spec;
    if (KNOWN_OPENAI_MODELS.has(base)) return { provider: "openai", model: base };
    if (KNOWN_OPENAI_MODELS.has(base.replace("-", "_").replace("_", "-"))) return { provider: "openai", model: base };
    return { provider: "openai", model: base };
  }
  const prefix = spec.slice(0, colon).toLowerCase();
  if (prefix === "openrouter") {
    return { provider: "openrouter", model: spec.slice(colon + 1) || spec };
  }
  if (ALL_PROVIDERS.includes(prefix as Provider)) {
    return { provider: prefix as Provider, model: spec.slice(colon + 1) };
  }
  return { provider: "openai", model: spec.slice(colon + 1) || spec };
}

// ─── Workload resolver ────────────────────────────────────────────────────────

const WORKLOAD_ENV: Record<Workload, string> = {
  gate: "ZO_MODEL_GATE",
  hyde: "ZO_MODEL_HYDE",
  crag: "ZO_MODEL_CRAG",
  extraction: "ZO_MODEL_EXTRACTION",
  summarization: "ZO_MODEL_SUMMARIZATION",
  briefing: "ZO_MODEL_BRIEFING",
  capture: "ZO_MODEL_CAPTURE",
  conversation: "ZO_MODEL_CONVERSATION",
  research: "ZO_MODEL_RESEARCH",
  embedding: "ZO_MODEL_EMBEDDING",
};

export function loadModelEnv(): void {
  try {
    const { readFileSync } = require("fs");
    const envPath = "/home/.z/config/model.env";
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      let line2 = trimmed;
      // Strip leading "export " prefix (shell-style)
      if (line2.startsWith("export ")) line2 = line2.slice(7);
      const eqIdx = line2.indexOf("=");
      if (eqIdx < 0) continue;
      const key = line2.slice(0, eqIdx).trim();
      const val = line2.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* no model.env */ }
}

const DEFAULT_MODELS: Record<Workload, string> = {
  gate: "openai:gpt-4o-mini",
  hyde: "openrouter:deepseek/deepseek-chat-v3-0324",
  crag: "openrouter:deepseek/deepseek-chat-v3-0324",
  extraction: "openrouter:deepseek/deepseek-chat-v3-0324",
  summarization: "openrouter:google/gemini-2.5-flash",
  briefing: "openrouter:google/gemini-2.5-flash",
  capture: "openrouter:deepseek/deepseek-chat-v3-0324",
  conversation: "openrouter:deepseek/deepseek-chat-v3-0324",
  research: "moa:default",
  embedding: "openai:text-embedding-3-small",
};

function resolveModel(workload: Workload, explicitModel?: string): { provider: Provider; model: string } {
  loadModelEnv();
  const envKey = WORKLOAD_ENV[workload];
  const spec = explicitModel || process.env[envKey] || "";
  if (spec) return parseModelSpec(spec);
  return parseModelSpec(DEFAULT_MODELS[workload]);
}

export function resolveConfiguredModel(workload: Workload, explicitModel?: string): { provider: Provider; model: string } {
  return resolveModel(workload, explicitModel);
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_TOKEN = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY || "";

async function openaiGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
    if (!opts.system) messages.unshift({ role: "system", content: "You are a JSON generator. Respond ONLY with valid JSON, no markdown or explanation." });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[openai/${model}] OpenAI error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage;
  const latency_ms = Date.now() - start;

  // USD per 1M tokens. Pre-2026-06-11 this billed $0.07/$0.28 per 1K —
  // exactly 466.67x real gpt-4o-mini rates; historical log rows need /466.67.
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;
  const cost_usd = calculateOpenAICostUsd(model, inputTokens, outputTokens);

  return {
    content,
    latency_ms,
    provider: "openai",
    model,
    cost_usd: Math.max(cost_usd, 0.00001),
    usage: usage ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
  };
}

async function openaiEmbeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const { model } = resolveModel("embedding", explicitModel);
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify({ input: text, model: model || "text-embedding-3-small" }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[openai] Embeddings error ${resp.status}`);
  const data = await resp.json() as { data?: Array<{ embedding?: number[] }>; usage?: unknown };
  const embedding = data.data?.[0]?.embedding || [];
  return { embedding, latency_ms: 0, provider: "openai", model, cost_usd: 0.00001 };
}

// ─── Local embedding tier (BGE-M3 / NV-Embed-v2 on the Hetzner GPU annex) ────
//
// ZOU-420: dual-home sync — mirrors packages/memory/src/standalone/model-client.ts.
// A self-hosted embedding model served by HuggingFace text-embeddings-inference
// (TEI) or Infinity on the compute annex (ZOU-414), exposing an OpenAI-compatible
// /v1/embeddings endpoint. Dormant unless ZO_EMBED_BASE_URL is set — when unset
// embeddings() is byte-identical to the OpenAI text-embedding-3-small default.
// When set, embeddings() short-circuits to localEmbeddings() before the provider
// switch, so the qdrant-rag MCP (which imports embeddings() via this module)
// reaches the self-hosted tier when armed. This is a REMOTE self-hosted endpoint,
// not the on-host Ollama paths removed 2026-05-29.
//
// ENV (all optional — local tier stays dormant otherwise):
//   ZO_EMBED_BASE_URL   → e.g. http://hetzner-gpu:8080   (REQUIRED to arm)
//   ZO_EMBED_MODEL      → served model id (default: bge-m3)
//   ZO_EMBED_API_KEY    → optional bearer
//   ZO_EMBED_DIM        → vector dim (default: 1024 for BGE-M3; informational)
//   ZO_EMBED_USD_PER_1K → amortized self-host cost per 1K tokens (default: 0)

const EMBED_LOCAL_BASE_URL = process.env.ZO_EMBED_BASE_URL || "";
const EMBED_LOCAL_MODEL = process.env.ZO_EMBED_MODEL || "bge-m3";
const EMBED_LOCAL_TOKEN = process.env.ZO_EMBED_API_KEY || "";
const EMBED_LOCAL_DIM = Number(process.env.ZO_EMBED_DIM || 1024) || 1024;
const EMBED_LOCAL_USD_PER_1K = Number(process.env.ZO_EMBED_USD_PER_1K || 0) || 0;
const EMBED_LOCAL_ENABLED = EMBED_LOCAL_BASE_URL.length > 0;

export function localEmbedTierArmed(): boolean { return EMBED_LOCAL_ENABLED; }

export function localEmbedConfig(): { baseURL: string; model: string; dim: number; armed: boolean } {
  return { baseURL: EMBED_LOCAL_BASE_URL, model: EMBED_LOCAL_MODEL, dim: EMBED_LOCAL_DIM, armed: EMBED_LOCAL_ENABLED };
}

export async function localEmbeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  if (!EMBED_LOCAL_ENABLED) throw new Error(`[local/${EMBED_LOCAL_MODEL}] ZO_EMBED_BASE_URL not configured`);
  const start = Date.now();
  const model = (explicitModel && explicitModel !== "text-embedding-3-small")
    ? explicitModel
    : EMBED_LOCAL_MODEL;
  const url = `${EMBED_LOCAL_BASE_URL.replace(/\/+$/, "")}/v1/embeddings`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (EMBED_LOCAL_TOKEN) headers["Authorization"] = `Bearer ${EMBED_LOCAL_TOKEN}`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: text, model }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) { lastErr = `HTTP ${resp.status}`; continue; }
      const data = await resp.json() as { data?: Array<{ embedding?: number[] }>; usage?: unknown };
      const embedding = data.data?.[0]?.embedding || [];
      if (embedding.length === 0) { lastErr = "empty embedding"; continue; }
      const tokEst = Math.max(1, Math.round(text.length / 4));
      const cost = (tokEst * EMBED_LOCAL_USD_PER_1K) / 1000;
      return {
        embedding,
        latency_ms: Date.now() - start,
        provider: "openai",
        model: `local/${model}`,
        cost_usd: Math.max(cost, 0.0),
      };
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`[local/${model}] ${lastErr}`);
}

export async function localEmbedHealthCheck(): Promise<HealthResult> {
  const start = Date.now();
  if (!EMBED_LOCAL_ENABLED) return { available: false, latency_ms: Date.now() - start, error: "ZO_EMBED_BASE_URL not set" };
  try {
    const modelsURL = `${EMBED_LOCAL_BASE_URL.replace(/\/+$/, "")}/v1/models`;
    const headers: Record<string, string> = {};
    if (EMBED_LOCAL_TOKEN) headers["Authorization"] = `Bearer ${EMBED_LOCAL_TOKEN}`;
    const resp = await fetch(modelsURL, { headers, signal: AbortSignal.timeout(5000) });
    return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

// ─── Anthropic (via Zo OAuth) ────────────────────────────────────────────────

// Zo OAuth: use the Zo platform identity token to call Anthropic through the Zo API
const ZO_TOKEN = process.env.ZO_CLIENT_IDENTITY_TOKEN || "";
const ZO_API_BASE = "https://api.zo.computer";

async function openaiCompatibleGenerate(
  baseUrl: string,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal
): Promise<{ content: string; latency_ms: number; cost_usd: number; usage?: { input_tokens: number; output_tokens: number } }> {
  const t0 = Date.now();
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://marlandoj.zo.computer",
      "X-Title": "ZoMemory",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
      // OpenRouter only returns the real billed cost (usage.cost) when asked.
      usage: { include: true },
    }),
    signal: signal ?? AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[openrouter] ${res.status}: ${err}`);
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: string | number };
  };
  const inTok = data.usage?.prompt_tokens ?? 0;
  const outTok = data.usage?.completion_tokens ?? 0;
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    latency_ms: Date.now() - t0,
    cost_usd: Number(data.usage?.cost ?? 0) || 0,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

async function openrouterGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const { model } = resolveModel(opts.workload, opts.model);
  const baseUrl = "https://openrouter.ai/api/v1";
  const prompt = typeof opts.prompt === "string" ? opts.prompt : String(opts.prompt ?? "");
  const result = await openaiCompatibleGenerate(
    baseUrl, model, prompt,
    opts.temperature ?? 0.7,
    opts.maxTokens ?? 256,
    opts.signal
  );
  return { content: result.content, latency_ms: result.latency_ms, cost_usd: result.cost_usd, provider: "openrouter", model, usage: result.usage };
}

// Opencode Zen — OpenAI-compatible at opencode.ai/zen/v1, Bearer OPENCODE_API_KEY.
// Reasoning models return text in reasoning_content when content is null. Note:
// the account balance can be zero (paid models 401 CreditsError) — use *-free
// model ids (e.g. "deepseek-v4-flash-free") until funded.
async function opencodeGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const key = process.env.OPENCODE_API_KEY || "";
  if (!key) throw new Error("OPENCODE_API_KEY not set — required for opencode provider");
  const { model } = resolveModel(opts.workload, opts.model);
  const t0 = Date.now();
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? WORKLOAD_TEMP[opts.workload],
      max_tokens: opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload],
    }),
    signal: opts.signal ?? AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`[opencode/${model}] ${res.status}: ${await res.text()}`);
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    cost?: string | number; // Opencode Zen returns the real billed cost at top level
  };
  const msg = data.choices?.[0]?.message ?? {};
  const content = ((msg.content ?? "").toString().trim()) || ((msg.reasoning_content ?? "").toString().trim());
  return {
    content,
    latency_ms: Date.now() - t0,
    provider: "opencode",
    model,
    cost_usd: Number(data.cost ?? 0) || 0,
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  };
}

async function opencodeEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "opencode", model: "unknown", cost_usd: 0, error: "opencode provider does not support embeddings" };
}

async function anthropicGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!ZO_TOKEN) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set — Zo OAuth required for Anthropic");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);

  // Map to Zo /zo/ask API which routes to Anthropic
  const system = opts.system
    ? `${opts.system}\n\nRespond ONLY with valid JSON.`
    : "Respond ONLY with valid JSON.";

  const resp = await fetch(`${ZO_API_BASE}/zo/ask`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ZO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: opts.prompt,
      model_name: `vercel:anthropic/${model}`,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[anthropic/${model}] Zo API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { output?: string; latency_ms?: number };
  const content = data.output || "";
  const latency_ms = data.latency_ms || Date.now() - start;

  return { content, latency_ms, provider: "anthropic", model, cost_usd: 0.001 };
}

async function anthropicEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "anthropic", model: "unknown", cost_usd: 0, error: "Anthropic embeddings not supported via Zo OAuth" };
}

// ─── MoA (Mixture-of-Agents) ─────────────────────────────────────────────────
//
// Cheap, non-Anthropic synthesis. Several open proposer models draft in parallel;
// one aggregator critically synthesizes a single answer (Opus-4.7 parity on
// ZouroBench memory synthesis at ~3.6x lower cost). Unlike the single-model
// "openrouter"/"opencode" providers, this floors max_tokens at 4096 (reasoning
// proposers starve content below that) and falls back content→reasoning, per the
// MoA-Fable eval contract. Spec: "moa:default" or "moa:<aggregator-slug>".
//
async function moaGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const lineup = resolveProductionMoaLineup(DEFAULT_PRODUCTION_MOA_LINEUP);
  const start = Date.now();
  const { model: aggregator } = resolveModel(opts.workload, opts.model);
  let aggSlug = !aggregator || aggregator === "default" ? lineup.aggregator : aggregator;
  const requestedAggregator = aggSlug;
  const requestedProposers = lineup.proposers;
  let lineupSource: NonNullable<GenerateResult["moa"]>["lineup_source"] = lineup.source;
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];
  const system = opts.json
    ? `${opts.system ? opts.system + "\n\n" : ""}Respond ONLY with valid JSON, no markdown or explanation.`
    : opts.system;

  let inTok = 0, outTok = 0, realCost = 0;
  let proposerModels = lineup.proposers;
  let drafts = await Promise.all(proposerModels.map((model) => callMoaModel(model, opts.prompt, {
    system, maxTokens, temperature, signal: opts.signal,
  })));
  if (drafts.filter((draft) => draft.ok && draft.text).length < 2 && lineup.source !== "fallback") {
    proposerModels = DEFAULT_PRODUCTION_MOA_LINEUP.proposers;
    lineupSource = "fallback-after-failure";
    if (proposerModels.includes(aggSlug)) aggSlug = DEFAULT_PRODUCTION_MOA_LINEUP.aggregator;
    drafts = await Promise.all(proposerModels.map((model) => callMoaModel(model, opts.prompt, {
      system, maxTokens, temperature, signal: opts.signal,
    })));
  }
  const usable: string[] = [];
  drafts.forEach((d, i) => {
    if (d.ok && d.text) {
      usable.push(`[Response ${i + 1} — ${proposerModels[i]}]\n${d.text}`);
      inTok += d.inputTokens; outTok += d.outputTokens; realCost += d.costUsd;
    }
  });
  if (usable.length < 2) throw new Error(`[moa] only ${usable.length} proposer succeeded; at least 2 are required`);

  const aggPrompt = `You have been provided with a set of responses from several AI models to the task below. Synthesize them into a single, high-quality answer. Critically evaluate the responses — they may be incomplete, partially correct, or contradictory. Do not merely copy; produce the most accurate, complete answer to the original task, following its formatting instructions exactly.

=== MODEL RESPONSES ===
${usable.join("\n\n")}

=== ORIGINAL TASK (answer this) ===
${opts.prompt}`;
  let agg = await callMoaModel(aggSlug, aggPrompt, { system, maxTokens, temperature, signal: opts.signal });
  if (!agg.ok && aggSlug !== DEFAULT_PRODUCTION_MOA_LINEUP.aggregator) {
    if (proposerModels.includes(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator)) {
      throw new Error("[moa] canonical fallback aggregator overlaps the active proposer set");
    }
    aggSlug = DEFAULT_PRODUCTION_MOA_LINEUP.aggregator;
    lineupSource = "fallback-after-failure";
    agg = await callMoaModel(aggSlug, aggPrompt, { system, maxTokens, temperature, signal: opts.signal });
  }
  if (!agg.ok || !agg.text) throw new Error(`[moa/${aggSlug}] ${agg.error ?? "aggregator failed"}`);
  inTok += agg.inputTokens; outTok += agg.outputTokens; realCost += agg.costUsd;

  return {
    content: agg.text,
    latency_ms: Date.now() - start,
    provider: "moa",
    model: `moa(${aggSlug})`,
    cost_usd: realCost,
    usage: { input_tokens: inTok, output_tokens: outTok },
    moa: {
      lineup_source: lineupSource,
      proposers_requested: requestedProposers,
      proposers_used: drafts.flatMap((draft, index) => draft.ok && draft.text ? [proposerModels[index]] : []),
      aggregator_requested: requestedAggregator,
      aggregator_used: aggSlug,
    },
  };
}

async function moaEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "moa", model: "unknown", cost_usd: 0, error: "moa provider does not support embeddings" };
}

// ─── Health checks ────────────────────────────────────────────────────────────

export async function modelHealthCheck(provider: Provider): Promise<HealthResult> {
  const start = Date.now();
  try {
    if (provider === "openai" && OPENAI_TOKEN) {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${OPENAI_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    if (provider === "anthropic" && ZO_TOKEN) {
      const resp = await fetch(`${ZO_API_BASE}/zo/ask`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ZO_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", model_name: "vercel:anthropic/haiku" }),
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    return { available: false, latency_ms: Date.now() - start, error: "No credentials" };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_WORKLOADS: Workload[] = ["gate", "extraction", "summarization", "briefing", "research"];

// Simple JSON file logger — zero dependencies, non-blocking
function logCall(result: GenerateResult, workload: Workload): void {
  if (!LOG_WORKLOADS.includes(workload)) return;
  try {
    const LOG_FILE = "/home/workspace/.zo/memory/model-call-log.jsonl";
    const entry = JSON.stringify({
      telemetry_version: 2,
      pricing_unit: "usd_per_1m_tokens",
      ts: new Date().toISOString(),
      workload,
      provider: result.provider,
      model: result.model,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      input_tokens: result.usage?.input_tokens,
      output_tokens: result.usage?.output_tokens,
    }) + "\n";
    // Bun: append to file without reading whole file
    const { writeFileSync, appendFileSync, existsSync } = require("fs");
    appendFileSync(LOG_FILE, entry);
  } catch { /* non-fatal */ }
}

function logEmbedCall(result: EmbedResult): void {
  // skip embedding logs for now
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const { provider } = resolveModel(opts.workload, opts.model);
  let result: GenerateResult;
  try {
    switch (provider) {
      case "openai":    result = await openaiGenerate(opts); break;
      case "anthropic": result = await anthropicGenerate(opts); break;
      case "openrouter": result = await openrouterGenerate(opts); break;
      case "opencode":  result = await opencodeGenerate(opts); break;
      case "moa":       result = await moaGenerate(opts); break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[model-client] ${provider} workload=${opts.workload} failed: ${msg}`);
    throw err;
  }
  logCall(result, opts.workload);
  return result;
}

export async function embeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  // Local embedding tier (ZOU-420): dormant-until-armed drop-in. When
  // ZO_EMBED_BASE_URL is set, short-circuit to the self-hosted endpoint
  // (BGE-M3/NV-Embed-v2 via TEI/Infinity); otherwise the provider switch below
  // is byte-identical to the pre-ZOU-420 OpenAI default.
  if (EMBED_LOCAL_ENABLED) return localEmbeddings(text, explicitModel);
  const { provider, model } = resolveModel("embedding", explicitModel);
  switch (provider) {
    case "openai":    { const r = await openaiEmbeddings(text, model); logEmbedCall(r); return r; }
    case "anthropic": return anthropicEmbeddings(text);
    case "openrouter": return openaiEmbeddings(text, model);
    case "opencode":  return opencodeEmbeddings(text);
    case "moa":       return moaEmbeddings(text);
  }
}
