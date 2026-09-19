#!/usr/bin/env bun
/**
 * fact-extractor.ts — Shared fact extraction logic for both inline and batch paths.
 *
 * Exports:
 *   extractAndStoreFacts() — extract facts from text, store to DB with dedup + embedding
 *   extractFactsFromText()  — extract facts only (no DB write, for dry-run/preview)
 */

import { generate as llmGenerate, embeddings as llmEmbed } from "./model-client";
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import {
  createEpisodeRecord,
  ensureContinuationSchema,
  extractOpenLoopsFromText,
  resolveMatchingOpenLoops,
  upsertOpenLoop,
} from "./continuation";

// --- Configuration ---
export const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";

const MIN_CONFIDENCE = 0.6;
const MIN_VALUE_LENGTH = 10;
const MAX_FACTS_PER_CAPTURE = 20;
const MAX_TRANSCRIPT_TOKENS = 6000;

const TTL_DEFAULTS: Record<string, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

export type DecayClass = "permanent" | "stable" | "active" | "session" | "checkpoint";
export type Category = "preference" | "fact" | "decision" | "convention" | "other" | "reference" | "project";

export interface CapturedFact {
  entity: string;
  key: string;
  value: string;
  category: Category;
  decay_class: DecayClass;
  confidence: number;
  source_quote: string;
}

export interface ExtractOptions {
  /** Human-readable source label, e.g. "inline:chat" or "conversation:abc123/file.md" */
  source: string;
  /** "inline" or "batch" — controls behavior and dedup tracking */
  captureMode: "inline" | "batch";
  /** Skip DB writes; return what would be stored */
  dryRun?: boolean;
  /** Persona scope (default: "shared") */
  persona?: string;
}

export interface ExtractResult {
  stored: CapturedFact[];
  skipped: Array<{ fact: CapturedFact; reason: string }>;
  contradictions: number;
  links_created: number;
  relation_receipts: number;
  duration_ms: number;
  source: string;
}

// --- Database ---

export function getExtractorDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_log (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      transcript_hash TEXT NOT NULL,
      facts_extracted INTEGER,
      facts_skipped INTEGER,
      contradictions INTEGER,
      model TEXT,
      duration_ms INTEGER,
      capture_mode TEXT DEFAULT 'batch',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);
  ensureContinuationSchema(db);
  ensureRelationReceiptSchema(db);
  return db;
}

// --- Ollama ---

const EXTRACTION_PROMPT = `You are a fact extractor. Given a conversation or document, extract structured, reusable facts.

Rules:
- Extract ONLY concrete, reusable facts (preferences, decisions, project details, technical choices, contacts, findings, commitments, constraints)
- Do NOT extract: greetings, questions, transient discussion, small talk, generic advice, opinions without action implications
- Each fact must be independently useful without the original document context
- Assign decay_class: "permanent" for user preferences/identity/personality, "stable" for project decisions/architecture, "active" for current tasks/in-progress work, "session" for one-off context
- Assign confidence: 1.0 for explicit statements, 0.8 for strong implications, 0.6 for weak inferences
- Include source_quote: the exact supporting text from the transcript (max 200 chars)
- entity format: "category.subject" (e.g., "user.preference", "project.ffb-site", "decision.hosting", "system.model-routing", "contact.supplier-x")
- Keep values concise but complete — the full useful fact, not a summary

Output ONLY a valid JSON array with: entity, key, value, category, decay_class, confidence, source_quote
Return [ ] if nothing worth extracting.
`;

export async function extractFactsFromText(text: string): Promise<CapturedFact[]> {
  const prompt = `${EXTRACTION_PROMPT}\n\nTranscript:\n---\n${text.slice(0, MAX_TRANSCRIPT_TOKENS)}\n---`;

  try {
    const result = await llmGenerate({
      prompt,
      workload: "extraction",
      temperature: 0.1,
      maxTokens: 2000,
    });
    const raw = result.content.trim();

    let jsonStr = raw;
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((f: any) => f.entity && f.value && f.key)
      .slice(0, MAX_FACTS_PER_CAPTURE)
      .map((f: any) => ({
        entity: String(f.entity),
        key: String(f.key),
        value: String(f.value),
        category: validateCategory(f.category),
        decay_class: validateDecay(f.decay_class),
        confidence: Math.min(1.0, Math.max(0, Number(f.confidence) || 0.7)),
        source_quote: String(f.source_quote || "").slice(0, 200),
      }));
  } catch (err) {
    console.error(`Extraction failed: ${err}`);
    return [];
  }
}

function validateCategory(c: string): Category {
  const valid: Category[] = ["preference", "fact", "decision", "convention", "other", "reference", "project"];
  return valid.includes(c as Category) ? (c as Category) : "fact";
}

function validateDecay(d: string): DecayClass {
  const valid: DecayClass[] = ["permanent", "stable", "active", "session", "checkpoint"];
  return valid.includes(d as DecayClass) ? (d as DecayClass) : "stable";
}

// --- Embedding ---

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await llmEmbed(text.slice(0, 8000));
    return result.embedding ?? null;
  } catch { return null; }
}

// --- Dedup & Contradiction ---

function checkExisting(
  db: Database,
  entity: string,
  key: string,
  value: string
): { isDuplicate: boolean; contradicts: string | null; existingValue: string | null } {
  const existing = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).all(entity, key, Math.floor(Date.now() / 1000)) as any[];

  if (existing.length === 0) return { isDuplicate: false, contradicts: null, existingValue: null };

  for (const row of existing) {
    if (row.value === value) return { isDuplicate: true, contradicts: null, existingValue: row.value };
  }

  return { isDuplicate: false, contradicts: existing[0].id, existingValue: existing[0].value };
}

// --- Jev fact-relation gate ---
// Advisory relation between a candidate fact and the existing same-key fact it would supersede.
// Questions, criteria and thresholds live in Skills/jev-skill-advisor/integrations/fact_relation.py.
// JEV_FACT_RELATION_MODE: off (default) | shadow (receipt only; supersede stays live) | advise.
// Any failure, timeout or malformed receipt falls back to the baseline supersede action.

export type RelationMode = "off" | "shadow" | "advise";
export type RelationAction = "supersede" | "skip" | "refine" | "coexist";
export interface RelationDecision {
  action: RelationAction;
  receipt: Record<string, any> | null;
}
export interface RelationInput {
  entity: string;
  key: string;
  existingId: string;
  existingValue: string;
  candidateValue: string;
  source: string;
}
export interface RelationOptions {
  mode?: RelationMode;
  script?: string;
  python?: string;
  timeoutMs?: number;
}

const RELATION_SCHEMA = "jev-fact-relation/v1";
const RELATION_ACTIONS: RelationAction[] = ["supersede", "skip", "refine", "coexist"];
const RELATION_SCRIPT_DEFAULT = "/home/workspace/Skills/jev-skill-advisor/integrations/fact_relation.py";
const RELATION_TIMEOUT_MS = 15000;

export function relationMode(): RelationMode {
  const raw = (process.env.JEV_FACT_RELATION_MODE || "off").trim().toLowerCase();
  return raw === "shadow" || raw === "advise" ? raw : "off";
}

export function ensureRelationReceiptSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jev_fact_relation_receipts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      existing_id TEXT NOT NULL,
      candidate_id TEXT,
      entity TEXT,
      key TEXT,
      source TEXT,
      baseline_action TEXT NOT NULL,
      recommended_relation TEXT,
      effective_action TEXT NOT NULL,
      probabilities TEXT,
      confidence REAL,
      incompatible REAL,
      same_information REAL,
      request_digest TEXT,
      pair_digest TEXT,
      elapsed_ms REAL,
      input_tokens INTEGER,
      estimated_cost_usd REAL,
      adapter_version TEXT,
      model TEXT,
      policy_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jev_fact_relation_existing ON jev_fact_relation_receipts(existing_id);
    CREATE INDEX IF NOT EXISTS idx_jev_fact_relation_created ON jev_fact_relation_receipts(created_at DESC);
  `);
}

function fallbackReceipt(mode: RelationMode, input: RelationInput, reason: string): Record<string, any> {
  return {
    schema_version: RELATION_SCHEMA,
    mode,
    status: "fallback",
    reason,
    existing_id: input.existingId,
    entity: input.entity,
    key: input.key,
    baseline: { relation: "contradiction", action: "supersede" },
    recommendation: null,
    effective: { relation: "contradiction", action: "supersede" },
    answers: null,
    usage: null,
    elapsed_ms: 0,
  };
}

export async function resolveFactRelation(input: RelationInput, opts: RelationOptions = {}): Promise<RelationDecision> {
  const mode = opts.mode ?? relationMode();
  if (mode === "off") return { action: "supersede", receipt: null };
  const script = opts.script ?? process.env.JEV_FACT_RELATION_SCRIPT ?? RELATION_SCRIPT_DEFAULT;
  const python = opts.python ?? process.env.JEV_FACT_RELATION_PYTHON ?? "python3";
  const timeoutMs = opts.timeoutMs ?? RELATION_TIMEOUT_MS;
  const payload = JSON.stringify({
    entity: input.entity,
    key: input.key,
    existing: { id: input.existingId, value: input.existingValue },
    candidate: { value: input.candidateValue },
    source: input.source,
  });
  let timedOut = false;
  try {
    const proc = Bun.spawn([python, script, "assess", "--mode", mode], {
      stdin: Buffer.from(payload),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (timedOut) return { action: "supersede", receipt: fallbackReceipt(mode, input, "timeout") };
    let parsed: any = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || parsed.schema_version !== RELATION_SCHEMA || parsed.status === "invalid") {
      return { action: "supersede", receipt: fallbackReceipt(mode, input, "invalid_receipt") };
    }
    const advised = parsed?.effective?.action;
    const action: RelationAction =
      mode === "advise" && parsed.status === "assessed" && RELATION_ACTIONS.includes(advised) ? advised : "supersede";
    return { action, receipt: parsed };
  } catch (err) {
    return { action: "supersede", receipt: fallbackReceipt(mode, input, timedOut ? "timeout" : "spawn_failed") };
  }
}

export function writeRelationReceipt(
  db: Database,
  decision: RelationDecision,
  extra: { candidateId: string | null; source: string }
): boolean {
  const r = decision.receipt;
  if (!r) return false;
  const answers = r.answers ?? null;
  try {
    db.prepare(`
      INSERT INTO jev_fact_relation_receipts (
        id, created_at, mode, status, reason, existing_id, candidate_id, entity, key, source,
        baseline_action, recommended_relation, effective_action, probabilities, confidence, incompatible,
        same_information, request_digest, pair_digest, elapsed_ms, input_tokens, estimated_cost_usd,
        adapter_version, model, policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), Math.floor(Date.now() / 1000), r.mode ?? "off", r.status ?? "fallback", r.reason ?? null,
      r.existing_id ?? "", extra.candidateId, r.entity ?? null, r.key ?? null, extra.source,
      "supersede", r.recommendation?.relation ?? null, decision.action,
      answers?.relation?.probabilities ? JSON.stringify(answers.relation.probabilities) : null,
      answers?.relation?.confidence ?? null, answers?.incompatible?.noul ?? null, answers?.same_information?.noul ?? null,
      r.request_digest ?? null, r.pair_digest ?? null, r.elapsed_ms ?? null,
      r.usage?.input_tokens ?? null, r.estimated_cost_usd ?? null, r.adapter_version ?? null, r.model ?? null,
      r.policy_version ?? null
    );
    return true;
  } catch (err) {
    console.error(`[fact-relation] receipt write failed: ${err}`);
    return false;
  }
}

// --- Main Pipeline ---

export async function extractAndStoreFacts(
  text: string,
  options: ExtractOptions
): Promise<ExtractResult> {
  const startTime = Date.now();
  const persona = options.persona || "shared";
  const db = getExtractorDb();

  const hash = createHash("sha256").update(text).digest("hex");
  const existing = db.prepare("SELECT id FROM capture_log WHERE transcript_hash = ? AND capture_mode = 'inline'").get(hash);
  if (existing) {
    db.close();
    return { stored: [], skipped: [], contradictions: 0, links_created: 0, relation_receipts: 0, duration_ms: 0, source: options.source };
  }

  // Model selection: model-client handles provider routing + fallback via ZO_MODEL_EXTRACTION
  const candidates = await extractFactsFromText(text);

  const stored: CapturedFact[] = [];
  const skipped: Array<{ fact: CapturedFact; reason: string }> = [];
  let contradictions = 0;
  let linksCreated = 0;
  let relationReceipts = 0;
  const storedIds: string[] = [];

  for (const fact of candidates) {
    if (fact.confidence < MIN_CONFIDENCE) {
      skipped.push({ fact, reason: `confidence ${fact.confidence} < ${MIN_CONFIDENCE}` });
      continue;
    }
    if (fact.value.length < MIN_VALUE_LENGTH) {
      skipped.push({ fact, reason: `value ${fact.value.length} chars < ${MIN_VALUE_LENGTH}` });
      continue;
    }

    const { isDuplicate, contradicts, existingValue } = checkExisting(db, fact.entity, fact.key, fact.value);
    if (isDuplicate) {
      skipped.push({ fact, reason: "duplicate" });
      continue;
    }

    let relation: RelationDecision | null = null;
    if (contradicts && !options.dryRun) {
      relation = await resolveFactRelation({
        entity: fact.entity,
        key: fact.key,
        existingId: contradicts,
        existingValue: existingValue ?? "",
        candidateValue: fact.value,
        source: options.source,
      });
      if (relation.action === "skip") {
        if (writeRelationReceipt(db, relation, { candidateId: null, source: options.source })) relationReceipts++;
        skipped.push({ fact, reason: "duplicate (jev)" });
        continue;
      }
    }

    if (options.dryRun) {
      const tag = contradicts ? "⚠" : "✓";
      console.log(`  ${tag} [${fact.entity}].${fact.key} = "${fact.value.slice(0, 60)}"`);
      if (contradicts) console.log(`     SUPERSEDES ${contradicts}`);
      stored.push(fact);
      continue;
    }

    const id = randomUUID();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const expiresAt = TTL_DEFAULTS[fact.decay_class] ? nowSec + TTL_DEFAULTS[fact.decay_class]! : null;
    const text2 = `${fact.entity} ${fact.key}: ${fact.value}`;

    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                         importance, source, created_at, expires_at, last_accessed, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, persona, fact.entity, fact.key, fact.value, text2,
      fact.category, fact.decay_class, 1.0, `fact-extractor:${options.source}`,
      now, expiresAt, nowSec, fact.confidence,
      JSON.stringify({ source_quote: fact.source_quote })
    );

    const embedding = await getEmbedding(text2);
    if (embedding) {
      db.prepare("INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
        .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
    }

    if (contradicts) {
      const action = relation?.action ?? "supersede";
      if (action === "supersede") {
        db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'supersedes', 1.0)")
          .run(id, contradicts);
        db.prepare("UPDATE facts SET confidence = confidence * 0.5 WHERE id = ?").run(contradicts);
        contradictions++;
      } else if (action === "refine") {
        db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'update_of', 1.0)")
          .run(id, contradicts);
        linksCreated++;
      }
      if (relation && writeRelationReceipt(db, relation, { candidateId: id, source: options.source })) relationReceipts++;
    }

    // Open loop resolution
    resolveMatchingOpenLoops(db, text);
    const loops = extractOpenLoopsFromText(text, options.source);
    for (const loop of loops) {
      if (loop.status === "resolved") continue;
      upsertOpenLoop(db, loop);
    }

    storedIds.push(id);
    stored.push(fact);
  }

  if (!options.dryRun && storedIds.length > 1) {
    for (let i = 0; i < storedIds.length; i++) {
      for (let j = i + 1; j < storedIds.length; j++) {
        db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'co-captured', 0.5)")
          .run(storedIds[i], storedIds[j]);
        linksCreated++;
      }
    }
  }

  const duration_ms = Date.now() - startTime;

  if (!options.dryRun) {
    db.prepare(`
      INSERT INTO capture_log (id, source, transcript_hash, facts_extracted, facts_skipped, contradictions, model, duration_ms, capture_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), options.source, hash, stored.length, skipped.length,
      contradictions, "model-client", duration_ms, options.captureMode
    );
  }

  db.close();
  return { stored, skipped, contradictions, links_created: linksCreated,
    relation_receipts: relationReceipts, duration_ms, source: options.source };
}
