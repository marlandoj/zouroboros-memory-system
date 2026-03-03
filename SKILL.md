---
name: zo-memory-system
description: Hybrid SQLite + Vector persona memory system for Zo Computer. Gives personas persistent memory with semantic search (nomic-embed-text), HyDE query expansion (qwen2.5:1.5b), Ollama-powered memory gate, 5-tier decay, and swarm integration. Requires Ollama for embeddings.
compatibility: Created for Zo Computer. Requires Bun and Ollama.
metadata:
  author: marlandoj.zo.computer
  updated: 2026-03-03
  version: 2.3.0
---
# Zo Memory System Skill v2.3.0

Give your Zo personas persistent memory with semantic understanding.

**v2.3 Updates:** Ollama-powered memory gate (memory-gate.ts), always-on context injection via Zo rules, 24h model keep-alive, gate-filtered token savings (40-60% of messages filtered)

---

## What You Get

- **Hybrid search** — BM25 (FTS5) + vector similarity with RRF fusion
- **Semantic understanding** — Finds facts even with paraphrased queries
- **HyDE expansion** — qwen2.5:1.5b query rewriting for vague searches (parallelized)
- **5-tier adaptive decay** — Automatic promotion/demotion based on access patterns
- **Local embeddings** — nomic-embed-text (768d) via Ollama (no API costs)
- **Per-persona memory files** — Critical facts always loaded with the persona
- **Shared memory database** — Cross-persona facts with vector index
- **Associative routing** — Graph links between related facts (link/graph commands)
- **Memory consolidation** — Automatic deduplication and merging of related facts
- **Swarm integration** — Token-optimized memory for multi-agent workflows
- **Memory gate** — Ollama-powered relevance filter (memory-gate.ts) that classifies messages before searching
- **Always-on injection** — Zo rule integration for automatic context injection on every message
- **Gate-filtered savings** — 40-60% of messages filtered as not needing memory (zero extra tokens)
- **Health checks** — Ollama connectivity and model validation at startup
- **Fetch timeouts** — 15s timeout on all Ollama calls (prevents indefinite hangs)
- **Scheduled maintenance** — Hourly prune/decay automation
- **Checkpoint system** — Save/restore task state
- **Graceful fallback** — Works without Ollama (FTS5 only)

---

## Prerequisites

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull required models
ollama pull nomic-embed-text   # Embeddings (768 dimensions)
ollama pull qwen2.5:1.5b       # HyDE query expansion (fast, ~1s generation)

# Start Ollama (if not running)
ollama serve &
```

### Model Selection

| Model | Purpose | Size | Why |
|-------|---------|------|-----|
| `nomic-embed-text` | Vector embeddings | 274 MB | Best open embedding model, 768d |
| `qwen2.5:1.5b` | HyDE expansion | 986 MB | Fast generation, good quality for query rewriting |

**Note:** Avoid larger models for HyDE (e.g., qwen3:30b) — the extra quality is wasted on query expansion and adds significant latency.

---

## Performance

| Mode | Latency | Use Case |
|------|---------|----------|
| **FTS + Vectors only** | ~0.5s | Specific queries with exact keywords |
| **With HyDE** | ~4s | Vague/conceptual queries (e.g., "that thing about data safety") |

**HyDE Trade-off:** Adds ~3.5s but dramatically improves recall for vague queries (1 result → 6 results in testing).

---

## Quick Start

```bash
# Initialize the database
cd /home/workspace/Skills/zo-memory-system
bun scripts/memory.ts init

# Add memory to a persona
bun scripts/add-persona.sh "my-persona" "Role description"

# Store a fact
bun scripts/memory.ts store \
  --entity "user" \
  --key "preference" \
  --value "value" \
  --decay permanent

# Search with semantic understanding
bun scripts/memory.ts hybrid "why did we choose the database"
```

---

## Commands

### Store Facts
```bash
bun scripts/memory.ts store \
  --persona shared \
  --entity "user" \
  --key "name" \
  --value "Alice" \
  --decay permanent \
  --category preference
```

### Search Memory

**Hybrid Search (v2 — semantic + exact):**
```bash
bun scripts/memory.ts hybrid "database decision rationale"
bun scripts/memory.ts hybrid "why did we pick SQLite" --no-hyde  # Skip HyDE for speed
```

**Fast Exact Search (v1 — FTS5 only):**
```bash
bun scripts/memory.ts search "router password"
```

**Lookup by entity:**
```bash
bun scripts/memory.ts lookup --entity "user"
bun scripts/memory.ts lookup --entity "user" --key "name"
```

### Maintenance
```bash
# View statistics (shows embeddings count, model config)
bun scripts/memory.ts stats

# Check Ollama health and model availability
bun scripts/memory.ts health

# Backfill embeddings for all facts
bun scripts/memory.ts index

# Prune expired facts and orphaned embeddings
bun scripts/memory.ts prune

# Apply adaptive decay (demotes stale, promotes frequently-accessed)
bun scripts/memory.ts decay

# Consolidate duplicate facts (merge same entity+key entries)
bun scripts/memory.ts consolidate
```

### Associative Routing (Graph Links)
```bash
# Link two related facts
bun scripts/memory.ts link --source <id1> --target <id2> --relation "related"

# View links for a fact or entity
bun scripts/memory.ts graph --entity "user"
bun scripts/memory.ts graph --id <fact-id>
```

---

## Memory Gate (Always-On Context Injection)

The memory gate (`scripts/memory-gate.ts`) uses a local Ollama model to classify incoming messages and decide whether memory context should be injected. This enables always-on memory without injecting into every message.

### How it works

1. User sends a message
2. Gate model (qwen2.5:1.5b) classifies: does this message need stored memory?
3. If no: message passes through with zero overhead
4. If yes: gate extracts keywords, runs hybrid search, injects results as context

### Usage

```bash
# Direct invocation
bun scripts/memory-gate.ts "what did we decide about FFB pricing?"
# Exit 0 + results printed

bun scripts/memory-gate.ts "hello"
# Exit 2 (no memory needed, no output)

bun scripts/memory-gate.ts "update the supplier scorecard"
# Exit 0 + results printed (or exit 3 if no results found)
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Memory results found and printed |
| 1 | Error (Ollama down, parse failure) |
| 2 | No memory needed (greeting, general knowledge, self-contained request) |
| 3 | Memory needed but no results found |

### Zo rule integration

Create an always-applied Zo rule that runs the gate on every message:

```
Run: bun /home/workspace/Skills/zo-memory-system/scripts/memory-gate.ts "<message>"
- Exit 0: inject stdout as background context
- Exit 2: skip (no memory needed)
- Exit 3: skip (no results)
```

### Configuration

```bash
export ZO_GATE_MODEL="qwen2.5:1.5b"  # Default gate model
export OLLAMA_URL="http://localhost:11434"
```

The gate uses `keep_alive: "24h"` to keep the model loaded in memory. A daily scheduled agent should ping the model to prevent cold starts (~35-58s on first load vs ~5-7s warm).

### Performance in multi-agent swarms

The gate is what makes this memory system viable for swarm workflows. Without gating, always-on injection consumes 34-120% of an 8K context budget across 11 tasks. With gating, only ~4 of 11 tasks get memory injection, keeping consumption at 2.5-6.9%.

| Metric | With gate | Without gate (always-on) |
|--------|-----------|--------------------------|
| Tasks injected | ~4 of 11 | All 11 |
| Memory tokens per swarm run | 800-2,200 | 12,100-38,500 |
| % of 8K context budget | 2.5-6.9% | 34-120% |

---

## Architecture

```
.zo/memory/
├── shared-facts.db          # SQLite database
│   ├── facts                # Core facts table
│   ├── facts_fts            # FTS5 virtual table
│   ├── fact_embeddings      # Vector embeddings (768d)
│   ├── fact_links           # Associative routing graph
│   └── embedding_cache      # Content hash cache
├── personas/
│   ├── [persona-1].md       # Critical facts per persona
│   └── [persona-2].md
├── checkpoints/
│   └── [timestamp].json     # Saved states
└── scripts/
    ├── memory.ts            # Main CLI (v2)
    ├── memory-gate.ts       # Ollama-powered relevance gate (v2.3)
    ├── add-persona.sh       # Persona setup helper
    └── schema.sql           # Database schema
```

### Search Flow (v2.1 — Parallelized)

```
Query → ┌─────────────────────────────────────┐
        │  Parallel Execution                 │
        │  ├── HyDE Expansion (qwen2.5:1.5b)  │
        │  ├── Query Embedding (nomic-embed)  │
        │  └── FTS5 Search (BM25)             │
        └─────────────────────────────────────┘
                        ↓
              RRF Fusion + Composite Score
                        ↓
              Ranked Results
```

---

## Configuration

Environment variables (optional):

```bash
export OLLAMA_URL="http://localhost:11434"      # Default
export ZO_EMBEDDING_MODEL="nomic-embed-text"    # Default
export ZO_HYDE_MODEL="qwen2.5:1.5b"             # Default
export ZO_HYDE_DEFAULT="true"                   # Default: use HyDE
export ZO_MEMORY_DB="/path/to/shared-facts.db"  # Default: .zo/memory/
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.3.0 | 2026-03-03 | Memory gate (memory-gate.ts), always-on context injection via Zo rules, 24h model keep-alive, gate-filtered token savings for swarm workflows |
| 2.2.0 | 2026-02-27 | Ollama health check, fetch timeouts, prune/decay/consolidate/link/graph commands, vector pre-filtering, adaptive decay, associative routing, PRAGMA busy_timeout |
| 2.1.0 | 2026-02-22 | Parallelized HyDE/FTS/embedding execution, optimized for qwen2.5:1.5b, performance docs |
| 2.0.0 | 2026-02-19 | Hybrid SQLite + Vector search, HyDE query expansion, semantic retrieval, nomic-embed-text via Ollama |
| 1.1.0 | 2026-02-18 | Added swarm v4 integration documentation |
| 1.0.0 | 2026-02-08 | Initial release - SQLite persona memory, 5-tier decay, FTS5 search |

---

## Related Skills

- `zo-swarm-orchestrator` — Multi-agent orchestration with token optimization

