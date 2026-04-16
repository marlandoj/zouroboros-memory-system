# Model Configuration

The memory-gate daemon and supporting scripts use a per-workload model routing layer
defined in `scripts/model-client.ts`. This document covers the configuration surface.

## Configuration file

**Canonical location**: `/home/.z/config/model.env`

This file is loaded at module init by `resolveModel()` in `model-client.ts`. It sets
per-workload model defaults via environment variables. Format:

```sh
# Workload-scoped routing
ZO_MODEL_GATE="openai:gpt-4o-mini"
ZO_MODEL_BRIEFING="openai:gpt-4o-mini"
ZO_MODEL_EXTRACTION="openai:gpt-4o-mini"
ZO_MODEL_SUMMARIZATION="openai:gpt-4o-mini"
ZO_MODEL_CAPTURE="openai:gpt-4o-mini"
ZO_MODEL_CONVERSATION="openai:gpt-4o-mini"
ZO_MODEL_HYDE="ollama:qwen2.5:1.5b"
ZO_MODEL_EMBEDDING="ollama:nomic-embed-text"
```

Values follow `provider:model` syntax. Supported providers: `ollama`, `openai`, `anthropic`.

## Provider secrets

Provider credentials come from process environment:

- `OPENAI_API_KEY` — required when any `ZO_MODEL_*` uses `openai:...`
- `ANTHROPIC_API_KEY` — required when any `ZO_MODEL_*` uses `anthropic:...`
- Ollama requires no key but expects a local server at `OLLAMA_URL` (default `http://localhost:11434`)

### Deployment note for `memory-gate` service

If you run the memory-gate daemon as a registered Zo user service, the API keys must be
in the **service's `env_vars`**, not merely in Zo Secrets. Service env_vars is a
*full replace* on update — always pass the complete env map:

```ts
update_user_service({
  service_id: "<id>",
  env_vars: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    // ... all other required vars
  }
});
```

Omitting a key here causes `openaiGenerate()` to throw at request time, which triggers
the fallback to Ollama. See the fallback logging in `model-client.ts` to detect this
silently-degraded state in `/dev/shm/memory-gate*.log`.

## Fallback behavior

If a remote provider throws (missing key, rate limit, network error), `generate()`
falls back to Ollama with a workload-appropriate default model. Failures are logged
to stderr prefixed with `[model-client]` so the degradation is visible in service logs.

If Ollama itself fails, the error is re-thrown (no secondary fallback).

## Telemetry

Every call is appended to `/home/.z/memory/model-call-log.jsonl`:

```json
{"ts": 1712345678, "workload": "gate", "provider": "openai", "model": "gpt-4o-mini", "latency_ms": 1234, "tokens_in": 420, "tokens_out": 12}
```

Use this log to verify routing is actually hitting the expected provider after a
config change.
