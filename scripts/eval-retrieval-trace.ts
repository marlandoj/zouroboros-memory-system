import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { retrieveInlineFtsCandidates } from "./inline-fts";

export type EvalRetrievalMethod =
  | "continuation"
  | "keyword_heuristic"
  | "llm_classifier"
  | "wikilink_fast_path";

export function validateDisposableDbPath(dbPath: string, allowedRoot: string): string {
  if (!dbPath || !allowedRoot || !isAbsolute(dbPath) || !isAbsolute(allowedRoot)) {
    throw new Error("evaluation database and root must be absolute paths");
  }
  const root = realpathSync(allowedRoot);
  const candidate = realpathSync(dbPath);
  const withinRoot = relative(root, candidate);
  if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error("evaluation database must be a file below the configured disposable root");
  }
  if (candidate.startsWith("/home/workspace/.zo/memory/")) {
    throw new Error("canonical memory databases are forbidden in evaluation mode");
  }
  if (!statSync(candidate).isFile()) throw new Error("evaluation database must be a file");
  return candidate;
}

export function buildInlineEvaluationTrace(options: {
  queryId: string;
  effectiveQuery: string;
  method: EvalRetrievalMethod;
  dbPath: string;
  allowedRoot: string;
  limit?: number;
  confidenceFloor: number;
}): {
  query_id: string;
  method: EvalRetrievalMethod;
  effective_query_sha256: string;
  candidates: Array<{ id: string; rank: number; score: number; superseded: boolean }>;
  latency_ms: number;
  mutation_mode: "disabled";
  contains_raw_text: false;
} {
  const dbPath = validateDisposableDbPath(options.dbPath, options.allowedRoot);
  const start = performance.now();
  const result = retrieveInlineFtsCandidates({
    query: options.effectiveQuery,
    dbPath,
    limit: options.limit ?? 20,
    confidenceFloor: options.confidenceFloor,
    evaluationReadOnly: true,
  });
  const candidates = result.candidates.map((candidate) => ({
    id: candidate.id,
    rank: candidate.rank,
    score: candidate.retrieval_score,
    superseded: candidate.superseded,
  }));
  const allowedKeys = ["id", "rank", "score", "superseded"];
  if (candidates.some((candidate) => {
    const keys = Object.keys(candidate).sort();
    return keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index]);
  })) {
    throw new Error("evaluation trace candidate payload contains an unsafe field");
  }
  return {
    query_id: options.queryId,
    method: options.method,
    effective_query_sha256: createHash("sha256").update(options.effectiveQuery).digest("hex"),
    candidates,
    latency_ms: Number((performance.now() - start).toFixed(3)),
    mutation_mode: "disabled",
    contains_raw_text: false,
  };
}
