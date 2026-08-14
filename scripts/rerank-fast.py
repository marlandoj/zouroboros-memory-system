#!/usr/bin/env python3
"""
rerank-fast.py — FlashRank cross-encoder reranker (sub-50ms, zero-API-cost).

Communicates via stdin/stdout JSON. Called from TypeScript/bun as a subprocess.

Input (stdin):  JSON object with "query" (string) and "passages" (string array).
Output (stdout): JSON object with "indices" (int array, reranked order) and "scores" (float array).

Usage:
  echo '{"query":"what is MCP","passages":["passage 1","passage 2","passage 3"]}' | python3 rerank-fast.py

Models (set via --model flag, or env RERANK_MODEL):
  default        → ms-marco-MiniLM-L-12-v2  (153 MB, ~35ms)
  tiny           → ms-marco-TinyBERT-L-2-v2  (♻ 18 MB, ~8ms)
  large          → ms-marco-MultiBERT-L-12    (♻ 570 MB, ~120ms)

Only the aliases above are served by flashrank 0.2.10. Any other value is
rejected with a clear error and non-zero exit (get_ranker guard) instead of
attempting a doomed 404 download; the caller then safely keeps the original
retrieval order. (bge / answer-ai were removed — their repos 404 in this build.)
The default model downloads on first use and caches in ~/.cache/huggingface.
Set RERANK_MODEL=tiny for sub-10ms latency at acceptable quality.
"""

import json
import sys
import os
import time
from typing import List, Tuple

MODEL_ALIASES = {
    "default": "ms-marco-MiniLM-L-12-v2",
    "tiny":    "ms-marco-TinyBERT-L-2-v2",
    "large":   "ms-marco-MultiBERT-L-12",
}

rankers = {}

def get_ranker(model_alias: str = "default"):
    if model_alias not in MODEL_ALIASES:
        raise ValueError(
            f"Unsupported reranker model '{model_alias}'. "
            f"Supported: {', '.join(MODEL_ALIASES)}. "
            "flashrank 0.2.10 serves no others; refusing to attempt a 404 download."
        )
    model_name = MODEL_ALIASES[model_alias]
    if model_name not in rankers:
        from flashrank import Ranker
        kwargs = {"model_name": model_name}
        cache_dir = os.environ.get("HF_HOME")
        if cache_dir:
            kwargs["cache_dir"] = cache_dir
        rankers[model_name] = Ranker(**kwargs)
    return rankers[model_name]

from flashrank.Ranker import RerankRequest

def rerank(query: str, passages: list, model_alias: str = "default") -> Tuple[List[int], List[float]]:
    ranker = get_ranker(model_alias)
    # Carry an explicit original-position id on every passage. FlashRank's rerank()
    # sorts the passage list in place, so any text->index map built AFTER the call
    # captures the already-sorted order and collapses to the identity permutation
    # (the reranker silently becomes a no-op). Preserving an "id" we control, and
    # reading it back off the results, is collision-proof and order-independent.
    if isinstance(passages[0], str):
        passages = [{"id": i, "text": p} for i, p in enumerate(passages)]
    else:
        passages = [{**p, "id": i} for i, p in enumerate(passages)]
    req = RerankRequest(query=query, passages=passages)
    results = ranker.rerank(req)
    pairs = [(int(r["id"]), float(r["score"])) for r in results if r.get("id") is not None]
    # results are score-sorted by FlashRank; sort defensively in case a version isn't.
    pairs.sort(key=lambda x: x[1], reverse=True)
    indices = [idx for idx, _ in pairs]
    scores = [s for _, s in pairs]
    return indices, scores

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--ping":
        model = os.environ.get("RERANK_MODEL", "default")
        t0 = time.time()
        try:
            get_ranker(model)
        except ValueError as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
        dt = (time.time() - t0) * 1000
        print(json.dumps({"ok": True, "model": MODEL_ALIASES[model], "load_ms": round(dt, 1)}))
        return

    model_alias = os.environ.get("RERANK_MODEL", "default")
    for arg in sys.argv[1:]:
        if arg.startswith("--model="):
            model_alias = arg.split("=", 1)[1]

    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    query = input_data.get("query", "")
    passages = input_data.get("passages", [])

    if not query:
        print(json.dumps({"error": "Missing 'query' field"}))
        sys.exit(1)
    if not passages:
        print(json.dumps({"indices": [], "scores": []}))
        return

    try:
        indices, scores = rerank(query, passages, model_alias)
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    print(json.dumps({"indices": indices, "scores": scores}))

if __name__ == "__main__":
    main()
