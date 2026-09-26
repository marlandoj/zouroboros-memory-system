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
ZO_MODEL_HYDE="openai:gpt-4o-mini"
ZO_MODEL_EMBEDDING="openai:text-embedding-3-small"
```

Values follow `provider:model` syntax. Supported providers: `openai`, `anthropic`, `openrouter`
(mirrors `export type Provider` in `scripts/model-client.ts`). There is no local-model
provider: `ollama:...` is not a valid spec and will not route.

## Provider secrets

Provider credentials come from process environment:

- `OPENAI_API_KEY` — required when any `ZO_MODEL_*` uses `openai:...`
- `ANTHROPIC_API_KEY` — required when any `ZO_MODEL_*` uses `anthropic:...`
- `OPENROUTER_API_KEY` — required when any `ZO_MODEL_*` uses `openrouter:...` (for example
  the `openrouter:deepseek-chat-v3-0324` extraction lane)

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

Omitting a key here causes `openaiGenerate()` or `openaiEmbeddings()` to throw at request
time. There is no local-model fallback lane: when a provider is unreachable the call
fails fast and the error surfaces to the caller.

## Fallback behavior

If a provider throws (missing key, rate limit, network error), the call fails fast and
the error is logged to stderr prefixed with `[model-client]`.

## Telemetry

Calls are appended to `/home/workspace/.zo/memory/model-call-log.jsonl` for the
`gate`, `extraction`, `summarization`, and `briefing` workloads only (the set is
`LOG_WORKLOADS` in `scripts/model-client.ts`; `hyde`, `capture`, `conversation`, and
`embedding` calls are not logged):

```json
{"ts":"2026-09-26T18:02:35.038Z","workload":"gate","provider":"openai","model":"gpt-4o-mini","latency_ms":613,"cost_usd":0.02975}
```

`ts` is an ISO-8601 string and `cost_usd` is the modelled cost from the pricing table
in `model-client.ts` — there is no `tokens_in` / `tokens_out` field, because the
OpenAI and OpenRouter responses are not token-accounted in the result type.

Use this log to verify routing is actually hitting the expected provider after a
config change.
