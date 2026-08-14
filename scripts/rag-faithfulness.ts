#!/usr/bin/env bun
/**
 * rag-faithfulness.ts — Diagnose and repair the RAG Health (retrieval faithfulness)
 * metric that the Zouroboros self-heal introspect scorecard reports.
 *
 * The metric (packages/selfheal/src/introspect/collector.ts → measureRAGHealth)
 * samples recent successful episodes, retrieves top-k context facts from
 * `facts_fts`, and asks an LLM to score how faithfully each episode summary is
 * grounded in the retrieved context. A low score means the retrieval surfaced
 * facts that do not support the episode's claims.
 *
 * This tool answers WHY the score is low using cheap, deterministic SQL signals
 * (no LLM), and offers one bounded, non-Goodhart remediation: rebuild the
 * external-content FTS index so retrieval can surface grounding facts it was
 * missing. It never edits the measurement logic and never deletes facts or
 * episodes — those are human-reviewed, trust-layer changes.
 *
 * Subcommands:
 *   diagnose [--json]    Classify the root cause; exits 0 always.
 *   repair   --reindex   Rebuild facts_fts (idempotent); exits 0 on success.
 *
 * DB resolution mirrors zouroboros-core getMemoryDbPath():
 *   ZOUROBOROS_MEMORY_DB || ZO_MEMORY_DB || ~/.zouroboros/memory.db
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

type RootCause =
  | "HEALTHY"
  | "STALE_INDEX"
  | "SPARSE_CORPUS"
  | "WEAK_RETRIEVAL"
  | "NO_EPISODES"
  | "DB_MISSING";

interface Diagnosis {
  rootCause: RootCause;
  dbPath: string;
  factsCount: number;
  ftsRows: number;
  episodesSampled: number;
  episodesWithContext: number;
  avgContexts: number;
  recommendation: string;
  recommendedCommand: string | null;
}

const CONTEXT_COVERAGE_TARGET = 0.6; // ≥60% of sampled episodes should retrieve ≥1 grounding fact
const SPARSE_CORPUS_FLOOR = 200; // below this, low coverage is a corpus problem, not retrieval

function resolveDbPath(): string {
  return (
    process.env.ZOUROBOROS_MEMORY_DB ||
    process.env.ZO_MEMORY_DB ||
    join(homedir(), ".zouroboros", "memory.db")
  );
}

/** Replicate the exact keyword extraction measureRAGHealth() uses for FTS retrieval. */
function episodeKeyword(text: string): string {
  const tokens = text
    .split(/\s+/)
    .slice(0, 5)
    .map((w) => w.replace(/[^\w]/g, ""))
    .filter((w) => w.length > 2);
  return tokens.length > 0 ? tokens.join(" OR ") : "";
}

function countFtsContexts(db: Database, keyword: string): number {
  if (!keyword) return 0;
  try {
    const rows = db
      .query(
        `SELECT f.value FROM facts_fts ff JOIN facts f ON f.rowid = ff.rowid
         WHERE facts_fts MATCH ? ORDER BY rank LIMIT 3`
      )
      .all(keyword) as { value: string }[];
    return rows.filter((r) => r.value && r.value.length > 0).length;
  } catch {
    // Malformed FTS query (rare after metachar strip) — treat as no context.
    return 0;
  }
}

function diagnose(): Diagnosis {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return {
      rootCause: "DB_MISSING",
      dbPath,
      factsCount: 0,
      ftsRows: 0,
      episodesSampled: 0,
      episodesWithContext: 0,
      avgContexts: 0,
      recommendation:
        "Memory DB not found. Confirm ZOUROBOROS_MEMORY_DB points at the production shared-facts.db.",
      recommendedCommand: null,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const factsCount =
      (db.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n ?? 0;

    let ftsRows = 0;
    try {
      ftsRows =
        (db.query("SELECT COUNT(*) AS n FROM facts_fts").get() as { n: number })
          .n ?? 0;
    } catch {
      ftsRows = -1; // facts_fts table absent
    }

    // Same sampling the metric uses: recent successful, non-capture episodes.
    const episodeRows = db
      .query(
        `SELECT e.id AS id,
                substr(d.text, 1, instr(d.text || char(10), char(10)) - 1) AS text
         FROM episodes e JOIN episode_documents d ON d.episode_id = e.id
         WHERE e.outcome = 'success' AND d.text NOT LIKE 'Conversation capture%'
         ORDER BY e.created_at DESC LIMIT 5`
      )
      .all() as { id: string; text: string }[];

    const episodes = episodeRows
      .map((r) => ({ id: r.id, text: (r.text || "").slice(0, 500) }))
      .filter((e) => e.text.length > 20);

    let withContext = 0;
    let totalContexts = 0;
    for (const ep of episodes) {
      const n = countFtsContexts(db, episodeKeyword(ep.text));
      if (n > 0) withContext += 1;
      totalContexts += n;
    }

    const sampled = episodes.length;
    const coverage = sampled > 0 ? withContext / sampled : 0;
    const avgContexts = sampled > 0 ? totalContexts / sampled : 0;

    let rootCause: RootCause;
    let recommendation: string;
    let recommendedCommand: string | null = null;

    if (ftsRows >= 0 && ftsRows !== factsCount) {
      rootCause = "STALE_INDEX";
      recommendation =
        `facts_fts holds ${ftsRows} rows but facts holds ${factsCount}. The external-content ` +
        `FTS index is out of sync with the source table, so retrieval misses grounding facts. ` +
        `Rebuild the index (safe, idempotent — no data is changed).`;
      recommendedCommand = "rag-faithfulness.ts repair --reindex";
    } else if (sampled === 0) {
      rootCause = "NO_EPISODES";
      recommendation =
        "No scoreable episodes (need episode_documents with summary text). Ensure episodes are " +
        "being recorded with documents before treating faithfulness as actionable.";
    } else if (coverage < CONTEXT_COVERAGE_TARGET) {
      if (factsCount < SPARSE_CORPUS_FLOOR) {
        rootCause = "SPARSE_CORPUS";
        recommendation =
          `Only ${withContext}/${sampled} sampled episodes retrieved any grounding fact and the ` +
          `corpus is small (${factsCount} facts). This is a coverage problem, not a retrieval bug — ` +
          `ingest more facts for the active project domains before retuning retrieval.`;
      } else {
        rootCause = "WEAK_RETRIEVAL";
        recommendation =
          `${withContext}/${sampled} sampled episodes retrieved grounding facts despite a healthy ` +
          `corpus (${factsCount} facts). The keyword strategy (first-5-words OR-joined FTS) is ` +
          `under-recalling. Recommended human-approved fix: route the metric's retrieval through ` +
          `rag-pipeline.ts (rerank/RRF) instead of raw inline FTS, then re-measure.`;
      }
    } else {
      rootCause = "HEALTHY";
      recommendation =
        `Retrieval surfaced grounding facts for ${withContext}/${sampled} sampled episodes ` +
        `(avg ${avgContexts.toFixed(1)} contexts). Retrieval coverage is healthy — a low ` +
        `faithfulness score is likely judge noise on a 5-episode sample or genuinely ungrounded ` +
        `episode claims. Re-measure before acting.`;
    }

    return {
      rootCause,
      dbPath,
      factsCount,
      ftsRows,
      episodesSampled: sampled,
      episodesWithContext: withContext,
      avgContexts,
      recommendation,
      recommendedCommand,
    };
  } finally {
    db.close();
  }
}

function repairReindex(): number {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[repair] DB not found: ${dbPath}`);
    return 1;
  }
  const db = new Database(dbPath);
  try {
    const before =
      (db.query("SELECT COUNT(*) AS n FROM facts_fts").get() as { n: number }).n ?? 0;
    const facts =
      (db.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n ?? 0;

    // External-content FTS5 rebuild: re-derives the index from `facts`. Idempotent;
    // changes no rows in the source table.
    db.run("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')");

    const after =
      (db.query("SELECT COUNT(*) AS n FROM facts_fts").get() as { n: number }).n ?? 0;

    console.log(
      `[repair] facts_fts rebuilt: ${before} → ${after} indexed rows (facts table: ${facts}).`
    );
    if (after !== facts) {
      console.log(
        `[repair] WARNING: index (${after}) still differs from facts (${facts}); ` +
          `investigate orphaned facts rows or missing FTS triggers.`
      );
    }
    return 0;
  } catch (e) {
    console.error(`[repair] reindex failed: ${(e as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

function printHuman(d: Diagnosis): void {
  console.log("RAG Faithfulness Diagnosis");
  console.log("==========================");
  console.log(`DB:                 ${d.dbPath}`);
  console.log(`Root cause:         ${d.rootCause}`);
  console.log(`Facts:              ${d.factsCount}`);
  console.log(`FTS index rows:     ${d.ftsRows < 0 ? "MISSING" : d.ftsRows}`);
  console.log(`Episodes sampled:   ${d.episodesSampled}`);
  console.log(`…with context:      ${d.episodesWithContext}`);
  console.log(`Avg contexts/ep:    ${d.avgContexts.toFixed(2)}`);
  console.log("");
  console.log(`Recommendation:     ${d.recommendation}`);
  if (d.recommendedCommand) {
    console.log(`Recommended action: bun ${d.recommendedCommand}`);
  }
}

function usage(): void {
  console.log(`rag-faithfulness.ts — diagnose & repair RAG Health (retrieval faithfulness)

USAGE:
  bun rag-faithfulness.ts diagnose [--json]
  bun rag-faithfulness.ts repair --reindex

SUBCOMMANDS:
  diagnose   Classify the root cause of low faithfulness (deterministic, no LLM).
             --json  Emit machine-readable JSON instead of a human report.
  repair     Bounded data hygiene.
             --reindex  Rebuild the facts_fts external-content index (idempotent).

ROOT-CAUSE CLASSES:
  STALE_INDEX     facts_fts out of sync with facts → repair --reindex
  SPARSE_CORPUS   too few grounding facts → ingest more facts
  WEAK_RETRIEVAL  healthy corpus, poor recall → human-approved retrieval refactor
  NO_EPISODES     no scoreable episode documents
  HEALTHY         coverage fine → re-measure; likely judge noise`);
}

function main(): void {
  const args = Bun.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage();
    process.exit(0);
  }

  if (cmd === "diagnose") {
    const d = diagnose();
    if (args.includes("--json")) {
      console.log(JSON.stringify(d, null, 2));
    } else {
      printHuman(d);
    }
    process.exit(0);
  }

  if (cmd === "repair") {
    if (!args.includes("--reindex")) {
      console.error("[repair] specify a bounded action: --reindex");
      process.exit(1);
    }
    process.exit(repairReindex());
  }

  console.error(`Unknown subcommand: ${cmd}`);
  usage();
  process.exit(1);
}

main();
