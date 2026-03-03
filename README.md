# Zo Memory System Skill v2.3

Give your Zo Computer personas persistent memory with semantic understanding and an Ollama-powered memory gate for always-on context injection.

## Prerequisites

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull required models
ollama pull nomic-embed-text   # Embeddings (768d)
ollama pull qwen2.5:1.5b       # HyDE query expansion + memory gate
```

## Installation

```bash
cd /home/workspace/Skills/zo-memory-system
./scripts/install.sh
```

## Quick Start

```bash
# Initialize database
bun .zo/memory/scripts/memory.ts init

# Add a persona
bun .zo/memory/scripts/add-persona.sh "backend-architect" "System design"

# Store a fact
bun .zo/memory/scripts/memory.ts store \
  --entity "user" \
  --key "preference" \
  --value "value" \
  --decay permanent

# Hybrid search (semantic + exact)
bun .zo/memory/scripts/memory.ts hybrid "why did we choose SQLite"

# Fast exact search (no vectors)
bun .zo/memory/scripts/memory.ts search "router password" --no-hyde
```

## Memory Gate (v2.3)

The memory gate classifies incoming messages and decides whether to inject stored memory context. This enables always-on memory without burning tokens on every message.

```bash
# Message that needs memory — returns results (exit 0)
bun scripts/memory-gate.ts "what did we decide about FFB pricing?"

# Greeting — skipped, no overhead (exit 2)
bun scripts/memory-gate.ts "hello"

# References stored work — returns results (exit 0)
bun scripts/memory-gate.ts "update the supplier scorecard"
```

**Exit codes:** 0 = results found, 1 = error, 2 = no memory needed, 3 = memory needed but no results

**Swarm performance:** The gate filters 40-60% of messages, keeping memory token consumption at 2.5-6.9% of context budget vs 34-120% without gating. See the [blog post](https://marlandoj.zo.space/blog/local-memory-vs-supermemory) for the full analysis.

## Performance

| Mode | Latency | Use Case |
|------|---------|----------|
| FTS + Vectors | ~0.5s | Specific queries |
| With HyDE | ~4s | Vague/conceptual queries |
| Memory gate (warm) | ~5-7s | Per-message classification |
| Memory gate (cold) | ~35-58s | First call after model unload |

## Documentation

- `SKILL.md` — Full documentation with architecture and configuration
- `scripts/demo.ts` — Interactive demo
- `assets/examples/` — Example persona memory files

## Files

```
zo-memory-system/
├── SKILL.md              # Main documentation (v2.3)
├── README.md             # This file
├── scripts/
│   ├── memory.ts         # Main CLI (parallelized v2.1)
│   ├── memory-gate.ts    # Ollama-powered relevance gate (v2.3)
│   ├── add-persona.sh    # Persona setup helper
│   ├── install.sh        # Install to workspace
│   ├── schema.sql        # Database schema
│   ├── demo.ts           # Demo script
│   └── package.json      # Dependencies
└── assets/
    └── examples/         # Example persona memory files
```

## Configuration

```bash
# Environment variables (optional)
export OLLAMA_URL="http://localhost:11434"
export ZO_EMBEDDING_MODEL="nomic-embed-text"
export ZO_HYDE_MODEL="qwen2.5:1.5b"
export ZO_GATE_MODEL="qwen2.5:1.5b"    # Memory gate model
```

## Updating

```bash
cd /home/workspace/Skills/zo-memory-system
./scripts/install.sh
```
