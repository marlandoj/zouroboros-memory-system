#!/usr/bin/env bun
/**
 * graph-boost.ts — Associative Graph Boost for Hybrid Search
 *
 * Queries fact_links for 1-hop neighbors of search results and adjusts
 * composite scores. Imported by memory.ts to enhance hybrid search.
 *
 * Scoring redistribution when graph links exist:
 *   RRF(0.60) + GraphBoost(0.15) + Freshness(0.15) + Confidence(0.10)
 *
 * When no links exist for any result, returns original scores unchanged.
 */

import { Database } from "bun:sqlite";

interface ScoredResult {
  id: string;
  rrfScore: number;
  freshness: number;
  confidence: number;
  sources: string[];
}

interface BoostedResult extends ScoredResult {
  graphBoost: number;
  composite: number;
}

interface FactLink {
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
}

/**
 * Compute graph-boosted composite scores for hybrid search results.
 *
 * For each result, queries fact_links for 1-hop neighbors.
 * If a neighbor is also in the result set, both get a graph boost.
 *
 * @param db - SQLite database handle
 * @param results - Scored results from RRF fusion (pre-composite)
 * @returns Results with graphBoost and reweighted composite scores
 */
export function computeGraphBoost(db: Database, results: ScoredResult[]): BoostedResult[] {
  if (results.length === 0) return [];

  const resultIds = new Set(results.map(r => r.id));

  // Batch-query all links where source OR target is in our result set
  const placeholders = results.map(() => "?").join(",");
  const links = db.prepare(`
    SELECT source_id, target_id, relation, weight
    FROM fact_links
    WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
  `).all(...results.map(r => r.id), ...results.map(r => r.id)) as FactLink[];

  // If no links exist for any result, return with original scoring weights
  if (links.length === 0) {
    return results.map(r => ({
      ...r,
      graphBoost: 0,
      composite: r.rrfScore * 0.7 + r.freshness * 0.2 + r.confidence * 0.1,
    }));
  }

  // Build adjacency: for each result id, accumulate boost from linked results
  const boostMap = new Map<string, number>();

  for (const link of links) {
    const { source_id, target_id, weight } = link;

    // Boost target if source is in results (and target is too)
    if (resultIds.has(source_id) && resultIds.has(target_id)) {
      boostMap.set(target_id, (boostMap.get(target_id) || 0) + weight);
      boostMap.set(source_id, (boostMap.get(source_id) || 0) + weight * 0.5); // Smaller reverse boost
    }
    // If only one side is in results, give a small boost to the one that is
    else if (resultIds.has(source_id)) {
      boostMap.set(source_id, (boostMap.get(source_id) || 0) + weight * 0.3);
    } else if (resultIds.has(target_id)) {
      boostMap.set(target_id, (boostMap.get(target_id) || 0) + weight * 0.3);
    }
  }

  // Normalize boost values to [0, 1]
  const maxBoost = Math.max(...Array.from(boostMap.values()), 1);

  return results.map(r => {
    const rawBoost = boostMap.get(r.id) || 0;
    const graphBoost = Math.min(rawBoost / maxBoost, 1.0);

    // Reweighted composite: RRF(0.60) + Graph(0.15) + Freshness(0.15) + Confidence(0.10)
    const composite = r.rrfScore * 0.6 + graphBoost * 0.15 + r.freshness * 0.15 + r.confidence * 0.1;

    return {
      ...r,
      graphBoost,
      composite,
    };
  });
}

/**
 * Inject graph-discovered neighbors into the result set.
 *
 * For top-N results, finds 1-hop neighbors that are NOT already in results
 * but are valid (non-expired) facts. Injects them with a graph-only score.
 *
 * @param db - SQLite database handle
 * @param topIds - IDs of top results to find neighbors for
 * @param existingIds - IDs already in the result set
 * @param maxInject - Maximum number of neighbors to inject
 * @returns Array of neighbor fact IDs with their link metadata
 */
export function findGraphNeighbors(
  db: Database,
  topIds: string[],
  existingIds: Set<string>,
  maxInject: number = 3
): Array<{ factId: string; linkedFrom: string; relation: string; weight: number }> {
  if (topIds.length === 0) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const placeholders = topIds.map(() => "?").join(",");

  const neighbors = db.prepare(`
    SELECT fl.source_id, fl.target_id, fl.relation, fl.weight
    FROM fact_links fl
    JOIN facts f ON (
      CASE WHEN fl.source_id IN (${placeholders}) THEN fl.target_id ELSE fl.source_id END
    ) = f.id
    WHERE (fl.source_id IN (${placeholders}) OR fl.target_id IN (${placeholders}))
      AND (f.expires_at IS NULL OR f.expires_at > ?)
    ORDER BY fl.weight DESC
    LIMIT ?
  `).all(...topIds, ...topIds, ...topIds, nowSec, maxInject * 3) as FactLink[];

  const injected: Array<{ factId: string; linkedFrom: string; relation: string; weight: number }> = [];

  for (const link of neighbors) {
    if (injected.length >= maxInject) break;

    // Determine which side is the neighbor (not in topIds)
    const isSourceTop = topIds.includes(link.source_id);
    const neighborId = isSourceTop ? link.target_id : link.source_id;
    const linkedFrom = isSourceTop ? link.source_id : link.target_id;

    // Skip if already in results or already injected
    if (existingIds.has(neighborId) || injected.some(i => i.factId === neighborId)) continue;

    injected.push({
      factId: neighborId,
      linkedFrom,
      relation: link.relation,
      weight: link.weight,
    });
  }

  return injected;
}
