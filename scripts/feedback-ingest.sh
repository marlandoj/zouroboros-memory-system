#!/usr/bin/env bash
# Auto-feedback capture — detects correction/praise signals in user prompts and stages
# trigger+response pairs for human review. Runs async from memory-gate-hook.sh.
# Input: Claude Code hook JSON on stdin (same format as UserPromptSubmit).

set -uo pipefail

STAGING="/root/.claude/projects/-home-workspace/memory/feedback_staged.md"
TRANSCRIPT_DIR="/root/.claude/projects/-home-workspace"

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

[[ -z "$PROMPT" ]] && exit 0

# Skip very short or very long messages — too short = noise, too long = system context
[[ ${#PROMPT} -lt 8 ]] && exit 0
[[ ${#PROMPT} -gt 1200 ]] && exit 0

# --- Signal detection (pattern matching, no LLM) ---
LOWER=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')

CORRECTION_SCORE=0
# Leading "no" scores 1 (needs paired corrective phrase to reach threshold of 3)
[[ "$LOWER" =~ ^(no[,\ ]|no\.) ]] && CORRECTION_SCORE=$((CORRECTION_SCORE + 1))
[[ "$LOWER" =~ (don\'t (add|use|write|put|create|include|do|make|push|commit|avoid|apply|send|call|run|edit|remove|delete|change|generate|start|continue|mix|inject)|do not|never do|stop doing|stop adding|stop using|stop putting|stop making) ]] && CORRECTION_SCORE=$((CORRECTION_SCORE + 3))
[[ "$LOWER" =~ (instead of|rather than|not like that|wrong approach|that\'s wrong|that is wrong) ]] && CORRECTION_SCORE=$((CORRECTION_SCORE + 2))
[[ "$LOWER" =~ (please don\'t|avoid doing|bad practice|incorrect approach) ]] && CORRECTION_SCORE=$((CORRECTION_SCORE + 1))

PRAISE_SCORE=0
[[ "$LOWER" =~ (perfect\.|perfect,|exactly right|exactly\.|exactly,) ]] && PRAISE_SCORE=$((PRAISE_SCORE + 3))
[[ "$LOWER" =~ (yes[,\ ].*(keep|do that|like that|exactly)|keep doing (this|that)|keep that) ]] && PRAISE_SCORE=$((PRAISE_SCORE + 3))
[[ "$LOWER" =~ (always do (this|that)|from now on.*always|good call|that\'s the right way) ]] && PRAISE_SCORE=$((PRAISE_SCORE + 2))

# Require score ≥ 3 to avoid false positives
if [[ $CORRECTION_SCORE -lt 3 && $PRAISE_SCORE -lt 3 ]]; then exit 0; fi

SIGNAL_TYPE="CORRECTION"
SIGNAL_SCORE=$CORRECTION_SCORE
if [[ $PRAISE_SCORE -gt $CORRECTION_SCORE ]]; then
  SIGNAL_TYPE="PRAISE"
  SIGNAL_SCORE=$PRAISE_SCORE
fi

# --- Validate and resolve transcript path (prevent path traversal + symlink attacks) ---
# realpath (no -m) resolves symlinks to their true target for accurate containment check
JSONL_FILE=""
expected_dir=$(realpath "$TRANSCRIPT_DIR" 2>/dev/null || echo "$TRANSCRIPT_DIR")

if [[ -n "$TRANSCRIPT_PATH" ]]; then
  real_path=$(realpath "$TRANSCRIPT_PATH" 2>/dev/null || true)
  # Split containment check: prefix match + suffix match (avoids glob ambiguity)
  if [[ -n "$real_path" && -f "$real_path" && \
        "$real_path" == "${expected_dir}/"* && "$real_path" == *.jsonl ]]; then
    JSONL_FILE="$real_path"
  fi
fi

# Fall back to newest JSONL in transcript dir — skip symlinks to prevent traversal
if [[ -z "$JSONL_FILE" ]]; then
  [[ -d "$expected_dir" ]] || exit 0
  newest_time=0
  for f in "$expected_dir"/*.jsonl; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
    if [[ "$mtime" -gt "$newest_time" ]]; then
      newest_time="$mtime"
      JSONL_FILE="$f"
    fi
  done
fi

# --- Extract last assistant turn (filename passed as argv, not interpolated into code) ---
LAST_ASSISTANT="[not captured]"
if [[ -n "$JSONL_FILE" && -f "$JSONL_FILE" ]]; then
  LAST_ASSISTANT=$(timeout 3 python3 - "$JSONL_FILE" <<'PYEOF' 2>/dev/null || echo "[not captured]"
import sys, json
fname = sys.argv[1] if len(sys.argv) > 1 else ''
if not fname:
    sys.exit(0)
try:
    import os as _os
    fd = _os.open(fname, _os.O_RDONLY | _os.O_NOFOLLOW)
    with _os.fdopen(fd, 'r', errors='replace') as fh:
        lines = fh.readlines()
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        if d.get('type') == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if isinstance(c, dict) and c.get('type') == 'text' and c['text'].strip():
                    print(c['text'][:600].strip())
                    sys.exit(0)
except Exception:
    pass
PYEOF
)
fi

# Ensure staging directory exists
mkdir -p "$(dirname "$STAGING")" 2>/dev/null || true

# --- Append staged entry with exclusive file lock (concurrent-safe, header init inside lock) ---
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
SIGNAL_TYPE_LOWER=$(printf '%s' "$SIGNAL_TYPE" | tr '[:upper:]' '[:lower:]')
TRIGGER="${LAST_ASSISTANT:0:600}"

{
  flock -x 9
  # Header init inside lock — check file size after exclusive lock acquired
  if [[ ! -s "$STAGING" ]]; then
    printf '%s\n' \
      '---' \
      'name: feedback-staged' \
      'description: Auto-captured correction/praise pairs pending human review and promotion to feedback_*.md' \
      'type: feedback' \
      '---' \
      '' \
      '# Staged Feedback Entries' \
      '' \
      'Auto-captured from UserPromptSubmit signals. Review and promote via:' \
      '`bun /home/workspace/Skills/zo-memory-system/scripts/feedback-promote.ts`' \
      '' >&9
  fi
  printf '\n---\n\n' >&9
  printf '**Captured:** %s | **Signal:** %s (score=%d)\n\n' "$TIMESTAMP" "$SIGNAL_TYPE" "$SIGNAL_SCORE" >&9
  printf '**Trigger — Alaric said:**\n' >&9
  if [[ -n "$TRIGGER" ]]; then
    while IFS= read -r line; do printf '> %s\n' "$line" >&9; done <<< "$TRIGGER"
  else
    printf '> [not captured]\n' >&9
  fi
  printf '\n**User %s:**\n' "$SIGNAL_TYPE_LOWER" >&9
  printf '> %s\n' "${PROMPT:0:400}" >&9
  printf '\n**Draft rule:** _[pending — run promote script to synthesize]_\n\n' >&9
} 9>> "$STAGING"

exit 0
