#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook — mechanical memory-gate enforcement.
# Reads hook JSON on stdin, calls the memory-gate daemon, prints context to stdout.
# Always exits 0; never blocks the prompt.

set -u

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
PERSONA="alaric"

if [[ -z "$PROMPT" ]]; then exit 0; fi

PAYLOAD=$(jq -n --arg m "$PROMPT" --arg p "$PERSONA" '{message:$m, persona:$p}')

RESPONSE=$(curl -s -m 4 -X POST http://localhost:7820/gate \
  -H 'Content-Type: application/json' \
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

exit 0
