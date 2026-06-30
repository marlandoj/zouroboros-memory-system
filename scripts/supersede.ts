#!/usr/bin/env bun
/**
 * P1-4 — supersedes-aware retrieval helpers.
 *
 * The entity graph (fact_links) carries temporal `supersedes` / `update_of` edges
 * where source_id is the NEW fact and target_id is the OLD/stale fact it replaces.
 * Retrieval never used them, so a stale-but-similar fact could out-rank its
 * replacement. These pure helpers identify which candidates are superseded so the
 * retrieval surfaces can downrank them (and optionally surface the replacement).
 *
 * No LLM, no network. A single batched query per call (mirrors computeGraphBoost).
 */

import type { Database } from "bun:sqlite";
import { p0FlagOn } from "./p0-1-gate";

/**
 * Temporal-replacement relations. A fact appearing as the TARGET of any of these
 * (with a live source) is "superseded". One constant so the set is trivial to widen.
 */
export const SUPERSEDE_RELATIONS = ["supersedes", "update_of"] as const;

/** Master switch (default ON). Set MEMORY_SUPERSEDE_SUPPRESS=0 to revert live. */
export function supersedeSuppressOn(): boolean {
  return p0FlagOn("MEMORY_SUPERSEDE_SUPPRESS");
}

/** Default multiplicative downrank for a superseded candidate. */
export const DEFAULT_SUPERSEDE_PENALTY = 0.3;

/**
 * Penalty factor in [0,1]. 1.0 ⇒ no penalty (identity). Lower ⇒ harder suppression.
 * Sourced from MEMORY_SUPERSEDE_PENALTY; clamped; default 0.3.
 */
export function supersedePenalty(): number {
  const raw = process.env["MEMORY_SUPERSEDE_PENALTY"];
  if (raw == null || raw.trim() === "") return DEFAULT_SUPERSEDE_PENALTY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SUPERSEDE_PENALTY;
  return Math.max(0, Math.min(1, n));
}

function relationPlaceholders(): string {
  return SUPERSEDE_RELATIONS.map(() => "?").join(",");
}

/**
 * Among `candidateIds`, return the set that is superseded — i.e. the TARGET of a
 * supersedes/update_of edge whose SOURCE is a live (existing, non-expired) fact.
 * Requiring a live source guards against orphaned/expired superseders falsely
 * hiding a fact. Set-based (no graph traversal) ⇒ cannot loop on chains.
 *
 * One batched query over the candidate ids.
 */
export function supersededSet(db: Database, candidateIds: string[]): Set<string> {
  const out = new Set<string>();
  if (candidateIds.length === 0) return out;

  const nowSec = Math.floor(Date.now() / 1000);
  const relPh = relationPlaceholders();
  const idPh = candidateIds.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT DISTINCT fl.target_id AS id
    FROM fact_links fl
    JOIN facts s ON s.id = fl.source_id
    WHERE fl.relation IN (${relPh})
      AND fl.target_id IN (${idPh})
      AND (s.expires_at IS NULL OR s.expires_at > ?)
  `).all(...SUPERSEDE_RELATIONS, ...candidateIds, nowSec) as Array<{ id: string }>;

  for (const r of rows) out.add(r.id);
  return out;
}

/**
 * The id of the NEWEST live fact that supersedes `staleId`, or null. Used to
 * surface the "current" fact when a top result is superseded.
 */
export function supersedingFact(db: Database, staleId: string): string | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const relPh = relationPlaceholders();

  const row = db.prepare(`
    SELECT s.id AS id
    FROM fact_links fl
    JOIN facts s ON s.id = fl.source_id
    WHERE fl.relation IN (${relPh})
      AND fl.target_id = ?
      AND (s.expires_at IS NULL OR s.expires_at > ?)
    ORDER BY s.created_at DESC
    LIMIT 1
  `).get(...SUPERSEDE_RELATIONS, staleId, nowSec) as { id: string } | null;

  return row?.id ?? null;
}

/**
 * Apply the supersede penalty to a composite score. flag off ⇒ identity;
 * not superseded ⇒ identity; includeSuperseded ⇒ identity.
 */
export function applySupersedePenalty(
  composite: number,
  isSuperseded: boolean,
  includeSuperseded = false,
): number {
  if (!isSuperseded || includeSuperseded || !supersedeSuppressOn()) return composite;
  return composite * supersedePenalty();
}
