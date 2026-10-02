#!/usr/bin/env bun
/**
 * P0-1 pure helpers — write-gate classifier + ACT-R recency factor.
 *
 * Kept in its own module (not memory.ts) because memory.ts runs main()
 * unconditionally on import, so it can't be imported by unit tests. Everything
 * here is pure/deterministic: no DB, no network, no LLM.
 */

import { calculateBaseLevel, ACTR_DEFAULTS } from "./actr";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Write-gate classifier (T2)
// ---------------------------------------------------------------------------

export type GateVerdict = "allow" | "hold" | "discard";

/**
 * Sources from the auto-capture / synthesis pipeline. Mirrors the read-time
 * quarantine regex in memory-gate-server.ts so the write-time `hold` decision
 * is the same population that was previously only filtered at read time.
 */
export const AUTO_SOURCE_PATTERN = /^(fact-extractor|conversation|inline|swarm|auto|rag|web|tool|mimir)/i;

/** Read-time quarantine floor (ZO_MEMORY_CONFIDENCE_FLOOR default in the gate server). */
export const DEFAULT_CONFIDENCE_FLOOR = 0.35;

/** A value shorter than this is a trivial artifact, not a durable fact. */
export const DEFAULT_MIN_VALUE_LENGTH = 12;

/**
 * Instruction-echo / acknowledgement artifacts — the agent repeating an
 * instruction back or acking, not durable knowledge. Conservative on purpose:
 * each pattern is anchored and non-factual, so a real fact won't match.
 */
const INSTRUCTION_ECHO_PATTERNS: RegExp[] = [
  /^(noted|got it|understood|ok(ay)?|sure|will do|done|thanks?|thank you)[.! ]*$/i,
  /^(please\s+)?(remember|note|keep in mind)\s+(to|that)\b/i,
  /^i'?ll?\s+(remember|note|make sure|keep|do)\b/i,
  /^as (you )?(requested|instructed|mentioned|asked|said)\b/i,
];

export interface GateInput {
  value: string;
  source?: string | null;
  confidence?: number | null;
}

export interface GateConfig {
  minLength: number;
  confidenceFloor: number;
  autoSourcePattern: RegExp;
}

export const GATE_DEFAULTS: GateConfig = {
  minLength: DEFAULT_MIN_VALUE_LENGTH,
  confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
  autoSourcePattern: AUTO_SOURCE_PATTERN,
};

/**
 * Classify a candidate write. Pure & deterministic — no LLM, no network.
 *   discard → drop (trivial artifact / instruction echo)
 *   hold    → store but keep out of default retrieval (low-signal auto-capture)
 *   allow   → store and retrieve normally
 */
export function classifyWrite(
  input: GateInput,
  config: GateConfig = GATE_DEFAULTS,
): GateVerdict {
  const value = (input.value ?? "").trim();

  // discard: too short to be a durable fact
  if (value.length < config.minLength) return "discard";

  // discard: instruction echo / acknowledgement artifact
  for (const re of INSTRUCTION_ECHO_PATTERNS) {
    if (re.test(value)) return "discard";
  }

  // hold: low-signal auto-captured row below the confidence floor. Makes the
  // existing read-time quarantine explicit at write time via gate_status.
  const isAuto = config.autoSourcePattern.test(String(input.source ?? "unknown"));
  const conf = input.confidence != null ? Number(input.confidence) : null;
  if (isAuto && conf != null && conf < config.confidenceFloor) return "hold";

  return "allow";
}

// ---------------------------------------------------------------------------
// ACT-R recency factor (T4)
// ---------------------------------------------------------------------------

/** Weight band for the recency multiplier. Final score scales within [1-w, 1]. */
export const RECENCY_WEIGHT = 0.15;

/**
 * Normalized recency factor in (0,1], sourced from actr.ts calculateBaseLevel
 * (reuses ACTR_DEFAULTS.decayRate — no invented constant). Higher = fresher.
 * Anchors on the most-recent of created/last-accessed so both "recently
 * created" and "recently accessed" raise the factor.
 *
 * @param createdAtSec    fact created_at in SECONDS (caller must convert ms→s)
 * @param lastAccessedSec fact last_accessed in SECONDS
 */
export function recencyFactor(createdAtSec: number, lastAccessedSec: number): number {
  const anchor = Math.max(createdAtSec || 0, lastAccessedSec || 0);
  const base = calculateBaseLevel(0, anchor, anchor, ACTR_DEFAULTS);
  return 1 / (1 + Math.exp(-base));
}

/**
 * Fold the recency factor into an existing composite score as a multiplicative
 * band. weight=0 ⇒ unchanged (flag-off parity). recency=1 ⇒ unchanged;
 * recency→0 ⇒ composite·(1-weight).
 */
export function applyRecencyDecay(
  composite: number,
  recency: number,
  weight: number = RECENCY_WEIGHT,
): number {
  return composite * (1 - weight + weight * recency);
}

// ---------------------------------------------------------------------------
// Store-time dedup-merge (T3)
// ---------------------------------------------------------------------------

/** Cosine threshold above which two same-(entity,persona) facts are merged. */
export const DEDUP_THRESHOLD = 0.85;

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Decode a fact_embeddings BLOB (Float32 little-endian) back to number[]. */
export function decodeEmbedding(blob: Uint8Array | ArrayBuffer): number[] {
  const u8 = blob instanceof ArrayBuffer ? new Uint8Array(blob) : blob;
  const f32 = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
  return Array.from(f32);
}

export interface DedupRow {
  id: string;
  embedding: number[];
}

/**
 * Return the id of the highest-cosine existing fact above `threshold`, or null.
 * Pure: candidate scoping (same entity/persona, unexpired) is the caller's SQL.
 */
export function findDuplicateId(
  candidate: number[],
  rows: DedupRow[],
  threshold: number = DEDUP_THRESHOLD,
): string | null {
  let bestId: string | null = null;
  let best = threshold;
  for (const r of rows) {
    if (!r.embedding || r.embedding.length !== candidate.length) continue;
    const sim = cosineSim(candidate, r.embedding);
    if (sim > best) {
      best = sim;
      bestId = r.id;
    }
  }
  return bestId;
}

/**
 * Merge a near-duplicate write into an existing row. Truthful provenance
 * (approved default): keep original created_at, bump last_accessed + merged_count.
 */
export function applyMerge(db: Database, dupId: string, nowSec: number): void {
  db.prepare(
    "UPDATE facts SET merged_count = merged_count + 1, last_accessed = ? WHERE id = ?",
  ).run(nowSec, dupId);
}

// ---------------------------------------------------------------------------
// Config flags (default ON per approved rollout; rollback = set to 0/off)
// ---------------------------------------------------------------------------

export function p0FlagOn(name: string, defaultOn = true): boolean {
  const v = process.env[name];
  if (v == null || v === "") return defaultOn;
  return !/^(0|false|off|no)$/i.test(v.trim());
}
