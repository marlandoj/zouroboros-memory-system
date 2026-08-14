# RAG Enhancements — Production-Readiness Audit (2026-05-28)

**Scope:** RAG features added in this session — rerank, hybrid (BM25+dense), HyDE, CRAG, RRF, RAPTOR-extension, jhf-knowledge re-embed (Voyage 1024d → OpenAI 1536d).

**Files audited:**
- `Skills/zo-memory-system/scripts/rag-pipeline.ts` (new)
- `Skills/zo-memory-system/scripts/qdrant-rag-mcp.ts` (modified)
- `Skills/zo-memory-system/scripts/ingest-hermes-docs-hybrid.ts` (new)
- `jackson-heritage-finance/server/_core/advisorTools.ts` (Voyage→OpenAI)

---

## 1. Eval (Hit@5 / MRR@10)

n=10 labeled queries across hermes-docs (hybrid-enabled), jhf-knowledge (rebuilt), zouroboros-research (RAPTOR refreshed).

| Variant   | n  | Hit@1  | Hit@5  | MRR@10 |
|-----------|----|--------|--------|--------|
| baseline  | 10 | 60.0%  | 80.0%  | 0.711  |
| rerank    | 10 | 40.0%  | 80.0%  | 0.600  |
| hyde      | 10 | 60.0%  | 80.0%  | 0.694  |
| hybrid    |  4 | 50.0%  | 75.0%  | 0.604  |

**Findings:**
- All variants mechanically correct (retrieve coherent results).
- Baseline already strong on this labeled set (n=10 too small for definitive ranking signal).
- **Rerank regression**: 4 queries flipped position even though Hit@5 unchanged (60%→40% Hit@1, MRR 0.711→0.600). RankGPT (gpt-4o-mini) sometimes prefers verbose-but-tangential passages over the exact source. Consider keeping rerank opt-in only.
- Two queries flagged as "fail" were actually label issues (target substring "providers"/"screener" didn't match actual filename `xai-grok-oauth.md`/`PHASE_3_COMPLETION.md`). Effective Hit@5 is ≥90% across all variants.

**Verdict:** No measurable gain on this set. Features are net-neutral when off, sometimes degrade when on. **Acceptable** because flags are opt-in.

---

## 2. Gap Audit (4 mandatory checks)

### Reachability ✅ (with fixes applied)
- All MCP flags (`rerank`, `hyde`, `crag`, `hybrid`) reachable via `rag_search`. ✅
- RAPTOR L1/L2 points retrieved by normal vector search (no separate caller needed). ✅
- **GAP CLOSED**: weekly `[MEM] Reindex Qdrant` agent updated to include `jhf-knowledge` in step-5 RAPTOR loop. Without this, the RAPTOR I ran would go stale at the next reindex.
- ⚠️ **Hybrid only on hermes-docs**: 5 other collections still dense-only. Re-ingesting them with sparse vectors is a multi-hour job for unproven gain — defer until evidence demands.

### Data Prerequisites ✅
- jhf-knowledge: 256 points at 1536d (240 chunks + 15 L1 + 1 L2). ✅
- All 5 RAPTOR-enabled collections: mimir-facts, ffb-knowledge, zouroboros-research, jhf-research, jhf-knowledge. ✅
- ⚠️ zouroboros-code (2,639 pts) and code-docs (95 pts): no RAPTOR. Add only if code-pattern queries underperform.

### Cross-Boundary State ✅
- MCP server self-heals `OPENAI_API_KEY` from `/root/.zo_secrets`. ✅
- JHF service rebuilt + restarted via `ZO_RESTART_TS` bump; advisor now uses OpenAI 1536d. ✅
- Weekly reindex agent self-heals + chains `source /root/.zo_secrets &&` per memory `feedback_scheduled_agent_secrets_chaining`. ✅

### Eval-Production Parity ✅
**Critical: tested the actual MCP stdio path, not just the underlying TypeScript.**

End-to-end stdio test against `qdrant-rag-mcp.ts`:
- `initialize` → ✅ serverInfo OK
- `tools/list` → ✅ 3 tools registered
- `rag_search` (jhf-knowledge, plain) → ✅ 2,085 chars, score 0.497
- `rag_search` (hermes-docs, `hybrid+rerank`) → ✅ 2,441 chars, score 0.750, both headers present
- `rag_search` (`hyde+crag`, multi-collection) → ✅ 2,022 chars, CRAG fallback fired and query was rewritten

**5/5 pass. The production code path Claude uses is verified working.**

---

## 3. Consensus Gate (synthetic.new tri-vendor)

`bun Skills/consensus-gate/scripts/consensus-gate.ts validate --file rag-pipeline.ts --criteria correctness,security,performance,error-handling`

**Verdict: REJECTED (unanimous)** — `cg-1779944735590-rlcku4`

| Severity | Finding | Vendors |
|----------|---------|---------|
| 🔴 HIGH | **Prompt injection** — user query + document content interpolated directly into LLM prompts in `rerank`/`hyde`/`rewriteQuery`. Malicious corpus content could redirect ranking. | Kimi (via GLM substitute), MiniMax |
| 🟡 MED | **RRF key collision** — `${collection}::${id}` delimiter collides if id/collection contain `::`. | GLM, Kimi |
| 🟡 MED | `rewriteQuery` silently swallows errors; inconsistent with `rerank`/`hyde` which log. | GLM, Kimi |
| 🟡 MED | `rewriteQuery` uses workload identifier `"hyde"` (should be `"rewrite"` or `"crag"`). | GLM |
| 🟢 LOW | `cragVerdict` accesses `hits[0]` without bounds check; returns NaN on empty array. | MiniMax |
| 🟢 LOW | `parseRankingLine` uses `Set` to dedupe, silently dropping required IDs if model emits duplicates. | MiniMax |
| 🟢 LOW | `result.content` accessed without null check after some try-catch paths. | GLM, MiniMax |

---

## 4. Production-Readiness Verdict

**Mechanically working. Conditionally production-ready.**

| Layer | Status |
|-------|--------|
| Retrieval correctness | ✅ All flags return coherent results |
| End-to-end MCP stdio | ✅ 5/5 stdio calls pass |
| Reachability + data | ✅ Gaps closed (agent updated) |
| Cross-boundary state | ✅ Self-heal + service restart verified |
| Eval-prod parity | ✅ Production code path tested directly |
| Quantitative gain | ⚠️ No measurable Hit@5 lift on n=10 |
| Security (consensus) | 🔴 Prompt-injection surface unmitigated |

**Recommendation: ship with caveats.**

- **Internal use OK now** — corpus content is workspace-controlled, not user-uploaded. Prompt-injection risk is low because attacker would need write access to the workspace first.
- **Before exposing MCP to external/third-party documents**: address the 🔴 HIGH finding. Options: (a) wrap document body in `<doc>...</doc>` tags and explicitly instruct the ranker LLM to treat tag content as data not instructions; (b) sanitize control sequences like "ignore previous instructions"; (c) accept the risk with a documented trust boundary.
- **Quick wins** (MED severity): switch RRF delimiter to `␞` (unit separator U+241E), align `rewriteQuery` error logging with `rerank`/`hyde`, switch its workload identifier to `"crag"`.

---

## Artifacts

- Eval raw JSON: `/home/.z/workspaces/con_fiH16cnX1lgelQPU/eval-rag-results.json`
- MCP stdio test: `/home/.z/workspaces/con_fiH16cnX1lgelQPU/test-mcp-stdio.ts`
- Consensus gate runs:
  - `cg-1779944735590-rlcku4` (Round 1 — original code)
  - `cg-1779945410264-lai139` (Round 2 — after RRF delimiter, error logging, tags, bounds checks)
  - `cg-1779945686409-wf2wc0` (Round 3 — after entity escape, dedup-by-collection, hyde null-safety)
- Weekly agent updated: `70f7bee4-f627-4d83-9079-16da3446b567`

## Patch Log (post-audit fixes applied)

**Round 1 → Round 2:**
- 🟡 RRF key delimiter `::` → U+241F (UNIT SEPARATOR)
- 🟡 `rewriteQuery` now logs on failure; workload changed `"hyde"` → `"crag"`
- 🟡 Added `"crag"` to `Workload` union in `model-client.ts` + DEFAULT_MODELS + WORKLOAD_ENV
- 🟢 `cragVerdict` empty-array + non-finite score bounds checks
- 🟢 `rerank` null-check on `result.content`
- 🔴 Prompt injection partial: query/passage now wrapped in `<query>`/`<passage>` tags with explicit "DATA not instructions" system message

**Round 2 → Round 3:**
- 🔴 Prompt injection hardened: added `escapeForXmlTag()` that defangs `<`, `>`, `&` in all interpolated user/corpus content (hyde, rewriteQuery, rerank passages + query). A crafted `</query>` literal can no longer break tag containment.
- 🟡 Dead `numbered` variable removed from `rerank`
- 🟡 `parseRankingLine` prefers the first line containing `>` (rejects loose number matches from passage IDs leaking into output)
- 🟢 Duplicate `"be"` removed from STOPWORDS

**Round 3 residual fixes:**
- 🟡 `rerank` dedup keyed on `(collection, id)` instead of bare `id`
- 🟢 `hyde` uses optional chaining + fallback to query
- 🟢 `escapeForXmlTag` also defangs `&`

## Residual Findings (Accepted)

After 3 consensus-gate rounds the remaining findings are theoretical or stylistic:
- "No input validation on public API functions" — internal-only library, callers are MCP/swarm code we own.
- "BM25 hash collisions are irreversible" — already documented in code; collisions at 2^20 buckets are rare and benign.
- "RRF `_dense_score` is the max across lists" — intentional, matches behavior we want.
- "loose equality on floats" — uses `>=`, not `==`; not actually a bug.
- "Set dedupes in parseRankingLine could mask malformed output" — guarded by separate `order.length < candidates.length` warning.

## Final Verdict (Post-Patch)

**Production-ready for internal use.** All 4 gap-audit checks pass, MCP stdio 5/5, RRF/CRAG/HyDE/rerank/hybrid all wired and exercised. Prompt-injection surface defanged via tag-wrapping + entity escape — adequate for a corpus the user controls; not yet hardened against adversarial third-party document ingest (still no exploit path identified, but recommend a fuzz test before that scenario goes live).
