#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook — mechanical memory-gate enforcement.
# Reads hook JSON on stdin, calls the memory-gate daemon, prints context to stdout.
# Always exits 0; never blocks the prompt.

set -u

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
ACTIVE_PERSONA=$(printf '%s' "$INPUT" | jq -r '.persona_id // empty' 2>/dev/null)
PERSONA="alaric"

# Skip memory gate for Alaric Voice — speed over context for voice sessions
if [[ "$ACTIVE_PERSONA" == "fe5d7648" ]]; then exit 0; fi

if [[ -z "$PROMPT" ]]; then exit 0; fi

# ZOU-451: inject top instincts (behavioral patterns) alongside memory facts.
# Domain-aware (prompt text boosts matching domains), additive, fail-open.
# Disable instinct injection entirely with INSTINCT_INJECT=0; no-op when the store is absent/empty.
# Semantic search arm (blended-rank vector retrieval) is ON by default; disable with INSTINCT_SEMANTIC=0.
# Both env vars survive the process boundary — bun inherits them from this shell.
if [[ "${INSTINCT_INJECT:-1}" == "1" && -f /home/workspace/.zo/instincts/instincts.yaml ]]; then
  INSTINCTS=$(timeout 5 bun /home/workspace/Skills/instinct-harvester/scripts/observer.ts \
    brief --top 5 --context "$PROMPT" 2>/dev/null)
  [[ -n "$INSTINCTS" ]] && printf '<instincts>\n%s\n</instincts>\n' "$INSTINCTS"
fi

PAYLOAD=$(jq -n --arg m "$PROMPT" --arg p "$PERSONA" '{message:$m, persona:$p}')

# Gate daemon requires a bearer token; read it from secrets if not already in env.
if [[ -z "${ZO_GATE_TOKEN:-}" ]]; then
  ZO_GATE_TOKEN=$(grep -m1 '^export ZO_GATE_TOKEN=' /root/.zo_secrets 2>/dev/null | cut -d= -f2-)
fi

# -f makes any HTTP >=400 (e.g. 401) produce empty output → falls back to local bun gate below.
RESPONSE=$(curl -sf -m 4 -X POST http://localhost:7820/gate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ZO_GATE_TOKEN}" \
  -d "$PAYLOAD" 2>/dev/null)

if [[ -z "$RESPONSE" ]]; then
  RESPONSE=$(timeout 8 bun /home/workspace/Skills/zo-memory-system/scripts/memory-gate.ts \
    --persona "$PERSONA" "$PROMPT" 2>/dev/null | tail -c 16384)
  [[ -z "$RESPONSE" ]] && exit 0
fi

EXIT_CODE=$(printf '%s' "$RESPONSE" | jq -r '.exit_code // 1' 2>/dev/null)
OUTPUT=$(printf '%s' "$RESPONSE" | jq -r '.output // empty' 2>/dev/null)

if [[ "$EXIT_CODE" == "0" && -n "$OUTPUT" ]]; then
  printf '<memory-gate>\n%s\n</memory-gate>\n' "$OUTPUT"
fi

# Async feedback capture — fire-and-forget, never blocks the prompt
printf '%s' "$INPUT" | setsid bash /home/workspace/Skills/zo-memory-system/scripts/feedback-ingest.sh \
  >> /dev/shm/feedback-ingest.log 2>&1 &

exit 0
