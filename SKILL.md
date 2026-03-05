---
name: zo-memory-system
description: Hybrid SQLite + Vector persona memory system for Zo Computer. Graph-boosted search, BFS path finding, knowledge gap analysis, auto-capture pipeline. Gives personas persistent memory with semantic search (nomic-embed-text), HyDE query expansion (qwen2.5:1.5b), Ollama-powered memory gate, 5-tier decay, and swarm integration. Requires Ollama for embeddings.
compatibility: Created for Zo Computer. Requires Bun and Ollama.
metadata:
  author: marlandoj.zo.computer
  updated: 2026-03-04
  version: 3.0.0
---
# Zo Memory System Skill v3.0.0

Give your Zo personas persistent memory with semantic understanding, graph intelligence, and automatic fact capture.

**v3.0 Updates:** Graph-boosted hybrid search (graph-boost.ts), BFS path finding & knowledge gap analysis (graph.ts), auto-capture pipeline for conversation-to-fact extraction (auto-capture.ts), co-capture linking, contradiction detection with supersession

---

## What You Get

- **Hybrid search** — BM25 (FTS5) + vector similarity with RRF fusion
- **Graph-boosted scoring** — Linked facts boost each other in search results
- **Semantic understanding** — Finds facts even with paraphrased queries
- **HyDE expansion** — qwen2.5:1.5b query rewriting for vague searches (parallelized)
- **BFS path finding** — Find shortest connection between any two entities
- **Knowledge gap analysis** — Identify orphan facts, dead ends, weak links, and clusters
- **Auto-capture** — Extract facts from conversation transcripts automatically
- **Contradiction detection** — New facts that conflict with existing ones create supersession links
- **5-tier adaptive decay** — Automatic promotion/demotion based on access patterns
- **Local embeddings** — nomic-embed-text (768d) via Ollama (no API costs)
- **Per-persona memory files** — Critical facts always loaded with the persona
- **Shared memory database** — Cross-persona facts with vector index
- **Associative routing** — Graph links between related facts (link/unlink/show commands)
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
ollama pull qwen2.5:1.5b       # HyDE query expansion + memory gate
ollama pull qwen2.5:7b         # Auto-capture fact extraction (optional)

# Start Ollama (if not running)
ollama serve &
```

### Model Selection

| Model | Purpose | Size | Why |
|-------|---------|------|-----|
| `nomic-embed-text` | Vector embeddings | 274 MB | Best open embedding model, 768d |
| `qwen2.5:1.5b` | HyDE expansion + gate | 986 MB | Fast generation, good quality for query rewriting |
| `qwen2.5:7b` | Auto-capture extraction | 4.4 GB | Reliable structured JSON extraction from transcripts |

**Note:** qwen2.5:7b is optional — auto-capture falls back to qwen2.5:3b if 7b is unavailable.

---

## Performance

| Mode | Latency | Use Case |
|------|---------|----------|
| **FTS + Vectors only** | ~0.5s | Specific queries with exact keywords |
| **With HyDE** | ~4s | Vague/conceptual queries (e.g., "that thing about data safety") |
| **Graph-boosted** | +~5ms | Adds graph scoring to any search (negligible overhead) |
| **Auto-capture** | ~3-5s | Per-conversation extraction (post-conversation, not per-turn) |

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

# Search with semantic understanding + graph boost
bun scripts/memory.ts hybrid "why did we choose the database"

# Manage knowledge graph
bun scripts/graph.ts link --source <id1> --target <id2> --relation "depends_on"
bun scripts/graph.ts knowledge-gaps

# Auto-capture facts from a conversation
bun scripts/auto-capture.ts --input conversation.md --dry-run
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

**Hybrid Search (semantic + exact + graph boost):**
```bash
bun scripts/memory.ts hybrid "database decision rationale"
bun scripts/memory.ts hybrid "why did we pick SQLite" --no-hyde  # Skip HyDE for speed
```

Hybrid search now includes graph-boosted scoring. When facts are linked via `fact_links`, linked results boost each other. Scoring weights:

| Signal | Weight | Notes |
|--------|--------|-------|
| RRF (FTS + Vector) | 0.60 | Primary signal |
| Graph Boost | 0.15 | Reward associative proximity |
| Freshness | 0.15 | Recency bonus |
| Confidence | 0.10 | Trust signal |

When no graph links exist for any result, original weights (0.70/0.20/0.10) are preserved.

**Fast Exact Search (FTS5 only):**
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

---

## Knowledge Graph (graph.ts)

The graph CLI manages associative links between facts and provides graph analysis tools.

### Link Management

```bash
# Create a link between two facts
bun scripts/graph.ts link --source <id1> --target <id2> --relation "depends_on" --weight 0.8

# Remove a link
bun scripts/graph.ts unlink --source <id1> --target <id2>
bun scripts/graph.ts unlink --source <id1> --target <id2> --relation "depends_on"

# Show all links for an entity or fact
bun scripts/graph.ts show --entity "project.ffb-site"
bun scripts/graph.ts show --id <fact-id>
```

### Find Connections (BFS Path Finding)

Find the shortest path between two entities through the knowledge graph:

```bash
bun scripts/graph.ts find-connections --from "project.ffb-site" --to "system.zo"
bun scripts/graph.ts find-connections --from "user" --to "decision.hosting" --max-depth 3
```

Output:
```
Path found (2 hops):

  [project.ffb-site.name] "FFB website redesign project"
    -->depends_on
  [decision.hosting] "Decided to use Zo hosting"
    -->related
  [system.zo.infrastructure] "Zo Computer infrastructure setup"
```

### Knowledge Gaps Analysis

Scan all facts for maintenance opportunities:

```bash
bun scripts/graph.ts knowledge-gaps
```

Output:
```
Knowledge Gap Analysis
======================
Total facts: 73
Linked facts: 14 (19.2%)
Orphan facts: 59 (80.8%)

Dead ends (targets only, never source):
  - [decision.hosting] "Decided to use Zo hosting" (2 inbound, 0 outbound)

Weakly linked (only 1 connection):
  - [project.ffb-api] "FFB API integration" (1 link)

Connected components: 3
  Cluster 1 (8 facts): hub = [project.ffb-site] (5 links)
  Cluster 2 (4 facts): hub = [system.zo-infrastructure] (3 links)
  Cluster 3 (2 facts): hub = [decision.memory-cli] (1 link)

Suggested: 12 orphan facts share entities with linked facts and could be connected.
```

---

## Auto-Capture (auto-capture.ts)

Extract structured facts from conversation transcripts automatically.

### How it works

1. Transcript is sent to qwen2.5:7b (or 3b fallback) for structured extraction
2. Each candidate fact is quality-filtered (confidence >= 0.6, value >= 10 chars)
3. Dedup check against existing facts (hash-based exact match)
4. Contradiction detection: same entity+key with different value creates a `supersedes` link
5. Passing facts are stored with embeddings and auto-linked as `co-captured`

### Usage

```bash
# Preview extraction (dry-run, no storage)
bun scripts/auto-capture.ts --input conversation.md --dry-run

# Extract and store
bun scripts/auto-capture.ts --input conversation.md --source "chat:2026-03-04"

# Pipe from swarm output
cat swarm-output.md | bun scripts/auto-capture.ts --source "swarm:ffb"

# View capture history
bun scripts/auto-capture.ts stats
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--input <file>` | Transcript file path | stdin |
| `--source <label>` | Source label for audit trail | "cli" |
| `--persona <name>` | Persona to store facts under | "shared" |
| `--dry-run` | Show extraction without storing | false |
| `--model <name>` | Override extraction model | qwen2.5:7b |

### Quality Safeguards

- **Confidence threshold**: Facts below 0.6 confidence are discarded
- **Value length minimum**: Facts with values shorter than 10 chars are discarded
- **Max 20 facts** per capture (prevents runaway extraction from long transcripts)
- **Transcript hash** prevents re-processing the same content
- **Dry-run mode** for testing extraction quality before committing
- **Source tagging** for audit trail (`source: "auto-capture:{label}"`)

### Contradiction Handling

When auto-capture finds an existing fact with the same entity+key but a different value:
1. New fact is stored normally
2. A `supersedes` link is created: new_fact → old_fact
3. Old fact's confidence is halved (soft deprecation, not deletion)

### Co-Capture Linking

Facts extracted from the same conversation are automatically linked with `relation: "co-captured"` and `weight: 0.5`. This seeds the knowledge graph with organic connections.

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
│   ├── capture_log          # Auto-capture history
│   └── embedding_cache      # Content hash cache
├── personas/
│   ├── [persona-1].md       # Critical facts per persona
│   └── [persona-2].md
├── checkpoints/
│   └── [timestamp].json     # Saved states
└── scripts/
    ├── memory.ts            # Main CLI with graph-boosted search (v3)
    ├── memory-gate.ts       # Ollama-powered relevance gate (v2.3)
    ├── graph.ts             # Knowledge graph CLI (v3.0)
    ├── graph-boost.ts       # Graph scoring module (v3.0)
    ├── auto-capture.ts      # Conversation-to-fact extraction (v3.0)
    ├── add-persona.sh       # Persona setup helper
    ├── schema.sql           # Database schema
    ├── test-graph.ts        # Graph integration tests
    └── test-capture.ts      # Auto-capture integration tests
```

### Search Flow (v3.0 — Graph-Boosted)

```
Query → ┌─────────────────────────────────────┐
        │  Parallel Execution                 │
        │  ├── HyDE Expansion (qwen2.5:1.5b)  │
        │  ├── Query Embedding (nomic-embed)  │
        │  └── FTS5 Search (BM25)             │
        └─────────────────────────────────────┘
                        ↓
              RRF Fusion (base scores)
                        ↓
              Graph Boost (fact_links)
                        ↓
              Neighbor Injection (linked facts)
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
export ZO_CAPTURE_MODEL="qwen2.5:7b"           # Default: auto-capture model
export ZO_MEMORY_DB="/path/to/shared-facts.db"  # Default: .zo/memory/
```

---

## Testing

```bash
# Run graph integration tests
bun scripts/test-graph.ts

# Run auto-capture integration tests
bun scripts/test-capture.ts
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0.0 | 2026-03-04 | Graph-boosted hybrid search (graph-boost.ts), BFS path finding & knowledge gap analysis (graph.ts), auto-capture pipeline (auto-capture.ts), co-capture linking, contradiction detection, scoring redistribution (RRF 0.60 + Graph 0.15 + Freshness 0.15 + Confidence 0.10) |
| 2.3.0 | 2026-03-03 | Memory gate (memory-gate.ts), always-on context injection via Zo rules, 24h model keep-alive, gate-filtered token savings for swarm workflows |
| 2.2.0 | 2026-02-27 | Ollama health check, fetch timeouts, prune/decay/consolidate/link/graph commands, vector pre-filtering, adaptive decay, associative routing, PRAGMA busy_timeout |
| 2.1.0 | 2026-02-22 | Parallelized HyDE/FTS/embedding execution, optimized for qwen2.5:1.5b, performance docs |
| 2.0.0 | 2026-02-19 | Hybrid SQLite + Vector search, HyDE query expansion, semantic retrieval, nomic-embed-text via Ollama |
| 1.1.0 | 2026-02-18 | Added swarm v4 integration documentation |
| 1.0.0 | 2026-02-08 | Initial release - SQLite persona memory, 5-tier decay, FTS5 search |

---

## Related Skills

- `zo-swarm-orchestrator` — Multi-agent orchestration with token optimization

## Design References

- `references/graphthulhu-concepts.md` — Design notes on GraphThulhu adaptations
- `references/supermemory-concepts.md` — Design notes on auto-capture inspiration
