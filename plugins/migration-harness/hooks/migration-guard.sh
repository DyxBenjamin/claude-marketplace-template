#!/bin/bash
# migration-guard.sh — PreToolUse guard for Bash while a migration is active.
#
# Purpose: during an active migration, the safe way back is the harness's
# checkpoints + file snapshots. Destructive shell commands (git reset --hard,
# rm -r, force pushes, DROP TABLE, …) can erase the very state a rollback needs.
# This guard blocks those *only* while a migration is active and unrecoverable,
# and stays completely out of the way otherwise.
#
# Contract: exit 0 = allow, exit 2 = block (stderr is shown to Claude).
# It fails OPEN — any error (no python, unparseable input) allows the command,
# so the guard can never wedge a session.

set -uo pipefail

INPUT=$(cat)

# --- Locate the migration state ------------------------------------------------
ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -n "$ROOT" ] || ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] || ROOT="$PWD"
MANIFEST="$ROOT/.migration/manifest.json"

# No migration here → never interfere.
[ -f "$MANIFEST" ] || exit 0

# --- Is a migration active? (status not done / rolled-back) --------------------
status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$MANIFEST" 2>/dev/null || true)
if [ -z "$status" ]; then
  status=$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
fi
case "$status" in
  "" | done | rolled-back) exit 0 ;;
esac

# --- Extract the command being run ---------------------------------------------
CMD=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)
# Fail safe toward inspection: if we could not parse, scan the raw payload.
[ -n "$CMD" ] || CMD="$INPUT"

# --- Destructive patterns (extended regex, case-insensitive) -------------------
# Kept BSD/macOS-grep compatible (no \b, no \d).
PATTERNS='git[[:space:]]+reset[[:space:]]+--hard'
PATTERNS+='|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'
PATTERNS+='|git[[:space:]]+checkout[[:space:]]+(--|\.)([[:space:]]|$)'
PATTERNS+='|git[[:space:]]+restore[[:space:]]'
PATTERNS+='|git[[:space:]]+push.*(--force|--force-with-lease|-f([[:space:]]|$))'
PATTERNS+='|git[[:space:]]+branch[[:space:]]+-D'
PATTERNS+='|git[[:space:]]+stash[[:space:]]+(drop|clear)'
PATTERNS+='|(^|[[:space:]])rm[[:space:]]+-[a-zA-Z]*r'
PATTERNS+='|drop[[:space:]]+(database|table|schema)'
PATTERNS+='|truncate[[:space:]]+table'

if printf '%s' "$CMD" | grep -iqE "$PATTERNS"; then
  OVERRIDE="$ROOT/.migration/.allow-destructive"
  if [ -f "$OVERRIDE" ]; then
    rm -f "$OVERRIDE"   # one-shot: consume the override so the guard re-arms
    exit 0
  fi
  cat >&2 <<EOF
migration-harness: blocked a potentially destructive command (migration status: $status).

  command: $CMD

Rollback in this harness restores from checkpoints + file snapshots, not from
destructive git/rm. Running this could erase state a rollback needs. Options:

  1. Checkpoint first, so this is recoverable:
       python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" checkpoint --label pre-destructive
  2. To undo a wave, prefer the safe path (it runs git internally):
       python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" rollback
  3. If you truly intend to run this exact command, override once:
       touch "$OVERRIDE"    # consumed after the next command, then re-armed

EOF
  exit 2
fi

exit 0
