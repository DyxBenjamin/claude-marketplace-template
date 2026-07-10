#!/bin/bash
# migration-guard.sh — PreToolUse guard that protects an ACTIVE migration.
#
# Wired (hooks.json) for two matchers, both pointing at this one script:
#   - Bash                              → inspect tool_input.command
#   - Write|Edit|MultiEdit|NotebookEdit → inspect tool_input.file_path
#
# Purpose: during an active migration the safe way back is the harness's
# checkpoints + file snapshots under .migration/. Two things can defeat that:
#   (1) a destructive shell command (git reset --hard, rm, > file, DROP TABLE…)
#       erasing the very state a rollback needs, and
#   (2) ANY tool clobbering .migration/ itself — which silently DISARMS this
#       guard forever, because the guard keys off .migration/manifest.json.
# This guard blocks both, but ONLY while a migration is active, and otherwise
# stays completely out of the way.
#
# Contract: exit 0 = allow, exit 2 = block (stderr is shown to Claude). Any
# other exit code is treated by Claude Code as a non-blocking error → allow.
#
# Failure posture (audit theme E):
#   - No .migration/ at all → allow everything (fail OPEN).                 [E1]
#   - .migration/manifest.json EXISTS but status is unparseable → BLOCK
#     (fail CLOSED): that is the exact lever an attacker/agent hits after
#     corrupting the manifest.                                             [E1]
#   - Any other internal error → there is no `set -e`; only the explicit
#     `exit 2` paths block, so the guard can never wedge a session.
#
# BSD/macOS grep compatible: extended regex only (no \b, no \d). Uses only
# coreutils + the Python stdlib.

set -uo pipefail

INPUT=$(cat)

# --- Locate the migration state (E7) ------------------------------------------
# Assumption: the migration root == the project root. Prefer the harness-provided
# CLAUDE_PROJECT_DIR; fall back to the git top-level, then $PWD. The git/$PWD
# fallback can resolve a *surrounding* repo when the project is not itself a git
# root (documented limitation) — CLAUDE_PROJECT_DIR is the reliable signal.
ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -n "$ROOT" ] || ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] || ROOT="$PWD"
MIGDIR="$ROOT/.migration"
MANIFEST="$MIGDIR/manifest.json"
OVERRIDE="$MIGDIR/.allow-destructive"

# No migration here → never interfere (fail OPEN).
[ -f "$MANIFEST" ] || exit 0

# --- Is a migration active? ----------------------------------------------------
status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$MANIFEST" 2>/dev/null || true)
if [ -z "$status" ]; then
  status=$(grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi

case "$status" in
  done | rolled-back)
    # Migration is finished → the guard stands down.
    exit 0
    ;;
  "")
    # Manifest EXISTS but we cannot determine its status → fail CLOSED (E1).
    # An unparseable/empty status is precisely what an attacker or a confused
    # agent lands on after corrupting the manifest, so we must block rather than
    # fall through to allow-all.
    cat >&2 <<EOF
migration-harness: BLOCKED — .migration/manifest.json exists but its "status"
could not be parsed. Failing CLOSED to protect the migration state.

Repair the manifest (restore a valid "status" field) or restore it from a
snapshot under .migration/snapshots/, then retry. If the migration is truly
finished, set the status to "done" or "rolled-back". Do NOT delete .migration/.
EOF
    exit 2
    ;;
esac
# Any other status ⇒ migration is ACTIVE ⇒ continue to the per-tool checks.

# --- Which tool is calling? ----------------------------------------------------
TOOL=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_name",""))' <<<"$INPUT" 2>/dev/null || true)
[ -n "$TOOL" ] || TOOL=$(grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"$INPUT" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# =============================================================================
# Write / Edit / MultiEdit / NotebookEdit — protect .migration/ from direct
# writes/edits (E1/E4). The sanctioned writer is `python3 .../migration.py`,
# which runs via Bash and therefore never reaches this branch → never blocked.
# =============================================================================
case "$TOOL" in
  Write | Edit | MultiEdit | NotebookEdit)
    FILE=$(python3 -c 'import json,sys
ti = json.load(sys.stdin).get("tool_input", {})
print(ti.get("file_path") or ti.get("notebook_path") or "")' <<<"$INPUT" 2>/dev/null || true)
    [ -n "$FILE" ] || FILE=$(grep -oE '"(file_path|notebook_path)"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"$INPUT" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

    # Could not determine a target path → fail OPEN (don't wedge legitimate edits).
    [ -n "$FILE" ] || exit 0

    # Writable carve-outs (WT1): the harness's own workflow writes under these
    # subtrees, so they must NOT be blocked — otherwise the documented flow is
    # unexecutable and the agent is pushed to arm the override:
    #   worktrees/  wave worktree checkouts (transformers Edit files INSIDE them)
    #   standards/  generated project standards (migrate-profile/-conventions/…)
    #   baseline/   captured golden outputs (migrate-safeguard)
    #   reports/    per-wave verification reports
    #   agent-io/   structured subagent I/O
    # Only manifest.json, manifest.lock, snapshots/, .gitignore, .allow-destructive
    # and the .migration root itself stay protected (below).
    if printf '%s' "$FILE" | grep -qE '(^|/)\.migration/(worktrees|standards|baseline|reports|agent-io)/'; then
      exit 0
    fi

    # Match ".migration" only as a real path component (so "foo.migration" and
    # ".migrations/" are NOT falsely blocked).
    if printf '%s' "$FILE" | grep -qE '(^|/)\.migration(/|$)'; then
      cat >&2 <<EOF
migration-harness: BLOCKED — $TOOL targets .migration/, the harness's protected
state (manifest, lock, snapshots).

  path: $FILE

Writing/editing there can corrupt the manifest and silently DISARM this guard.
Only the harness may write under .migration/:
  python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command>
EOF
      exit 2
    fi
    exit 0
    ;;
esac

# =============================================================================
# Bash (and any other tool, as a safety net) — inspect the command string.
# =============================================================================
CMD=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' <<<"$INPUT" 2>/dev/null || true)
# Fail toward inspection: if we could not parse, scan the raw payload.
[ -n "$CMD" ] || CMD="$INPUT"

# --- One-shot override (E6 FIX) -----------------------------------------------
# BUG (audit E6): the old `rm -f "$OVERRIDE"` lived INSIDE the destructive-match
# block, so a benign command never consumed it and it leaked to a LATER
# destructive command. Correct behaviour: the override authorises exactly the
# VERY NEXT Bash command — whatever it is, destructive or not — then re-arms.
# So consume it HERE, before any matching, and allow this one command.
if [ -f "$OVERRIDE" ]; then
  rm -f "$OVERRIDE" 2>/dev/null || true
  exit 0
fi

# --- Self-protection: block ops that remove/move/truncate/redirect .migration/ -
# (E1/E4) Because the guard keys off .migration/manifest.json, clobbering it
# disarms the guard forever. Block any shell op that would remove, move,
# truncate, overwrite, or redirect onto anything under .migration/. This is the
# tamper-proofing the audit says matters most, so it is NOT subject to the
# build-dir allowlist below. ".migration" is matched only as a real path
# component (…/.migration or a trailing/standalone .migration).
MIG='(^|[[:space:]/])(rm|mv|cp|dd|truncate|shred|tee|install|ln|rsync)[[:space:]][^|;&]*\.migration(/|[[:space:]]|$)'
MIG+='|>>?[[:space:]]*[^|;&<>]*\.migration(/|[[:space:]]|$)'
# Protected targets: the manifest, lock, snapshots, gitignore, override, or the
# .migration root itself (bare, trailing, or as a whole-dir operand). Clobbering
# any of these disarms the guard / destroys rollback state.
MIG_PROT='\.migration/(manifest\.[^[:space:]/]*|snapshots|\.gitignore|\.allow-destructive)'
MIG_PROT+='|\.migration([[:space:]]|/[[:space:]]|/?$)'
# Writable carve-outs (WT1): same subtrees exempted for Write/Edit above.
MIG_CARVE='\.migration/(worktrees|standards|baseline|reports|agent-io)/'
if grep -qE "$MIG" <<<"$CMD"; then
  # A command that touches ONLY a writable carve-out (and no protected target) is
  # legitimate harness work — allow it. Anything touching a protected target, or
  # an unrecognised .migration path, is blocked (default-deny).
  if ! grep -qE "$MIG_PROT" <<<"$CMD" && grep -qE "$MIG_CARVE" <<<"$CMD"; then
    :  # carve-out only → fall through, do not block
  else
  cat >&2 <<EOF
migration-harness: BLOCKED — this command targets .migration/, the harness's
protected state (manifest, lock, snapshots).

  command: $CMD

Clobbering it would silently DISARM this guard and destroy the rollback/audit
trail. Only the harness may write there:
  python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command>

To run this exact command anyway, authorise the NEXT command once:
  touch "$OVERRIDE"    # consumed by the very next Bash command, then re-armed
EOF
  exit 2
  fi
fi

# --- False-positive relief (E5): allow recursive rm of obvious build/temp dirs -
# Anchored to a SINGLE clean target so it can never allowlist a compound command
# (e.g. `rm -rf node_modules && rm secrets.env` does NOT match → still blocked),
# and MIG above already ran, so nothing under .migration/ can slip through here.
SAFE_RM='^[[:space:]]*(/[^[:space:]]*/)?rm[[:space:]]+-[rRfv]+[[:space:]]+(\./)?(node_modules|dist|build|\.cache|\.next|\.nuxt|coverage|out|target|__pycache__|\.pytest_cache)/?[[:space:]]*$'
SAFE_RM_TMP='^[[:space:]]*(/[^[:space:]]*/)?rm[[:space:]]+-[rRfv]+[[:space:]]+((/private)?/tmp/|\$TMPDIR/)[^[:space:]]*[[:space:]]*$'
# WT1: a SINGLE `rm`/`git rm` whose only target is inside a wave worktree (or the
# other harness work subtrees) is legitimate — cleanup deletes dead code IN the
# worktree, transformers delete files there. Whole-string-anchored to one target
# so a compound (`rm .migration/worktrees/x && rm -rf /`) can NOT match and is
# still caught by the destructive patterns below. The MIG self-protection block
# above already ran, so manifest/lock/snapshots can't slip through here.
SAFE_RM_WT='^[[:space:]]*(git[[:space:]]+)?(/[^[:space:]]*/)?rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(\./)?\.migration/(worktrees|standards|baseline|reports|agent-io)/[^[:space:]]*[[:space:]]*$'
if grep -qE "$SAFE_RM" <<<"$CMD" || grep -qE "$SAFE_RM_TMP" <<<"$CMD" || grep -qE "$SAFE_RM_WT" <<<"$CMD"; then
  exit 0
fi

# --- Destructive patterns ------------------------------------------------------
# SQL DDL is matched CASE-INSENSITIVELY (SQL keywords are case-insensitive)…
SQL='drop[[:space:]]+(database|table|schema)'
SQL+='|truncate[[:space:]]+table'
# …everything else CASE-SENSITIVELY (Unix commands & git flags are case
# sensitive — this is exactly what lets `git branch -d` (safe delete) pass while
# `git branch -D` (force) blocks, and `git clean -n` pass while `-f` blocks).
DESTRUCT='git[[:space:]]+reset[[:space:]]+--hard'
DESTRUCT+='|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'
DESTRUCT+='|git[[:space:]]+checkout[[:space:]]+(--force|-f([[:space:]]|$)|--([[:space:]]|$)|\.([[:space:]]|$))'
DESTRUCT+='|git[[:space:]]+switch[[:space:]]+(--discard-changes|--force|-f)([[:space:]]|=|$)'
DESTRUCT+='|git[[:space:]]+push[^|;&]*(--force-with-lease|--force|(^|[[:space:]])-f([[:space:]]|$))'
DESTRUCT+='|git[[:space:]]+branch[[:space:]]+-D'
DESTRUCT+='|git[[:space:]]+stash[[:space:]]+(drop|clear)'
DESTRUCT+='|git[[:space:]]+rm([[:space:]]|$)'
DESTRUCT+='|git[[:space:]]+update-ref[[:space:]]+-d'
DESTRUCT+='|(^|[[:space:]/])rm[[:space:]]'
DESTRUCT+='|(^|[[:space:]/])truncate[[:space:]]+-s'
DESTRUCT+='|(^|[[:space:]/])dd[[:space:]][^|;&]*of='
DESTRUCT+='|(^|[[:space:]/])find[[:space:]][^|;&]*-delete'
DESTRUCT+='|(^|[[:space:]/])find[[:space:]][^|;&]*-exec[[:space:]]+(rm|mv|sh|bash)'
DESTRUCT+='|(^|[[:space:]/])xargs[[:space:]][^|;&]*(rm|mv|dd|truncate)'
DESTRUCT+='|(^|[[:space:]/])sed[[:space:]]([^|;&]*[[:space:]])?-i'
DESTRUCT+='|(curl|wget)[[:space:]][^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash)([[:space:]]|$)'
DESTRUCT+='|(^|[[:space:]])>[[:space:]]*[^/&|;<>[:space:]]'

is_destructive() {
  grep -iqE "$SQL" <<<"$CMD" && return 0
  grep -qE "$DESTRUCT" <<<"$CMD" && return 0
  # `git restore` that touches the WORKTREE is destructive; `--staged`/`-S` is
  # index-only (safe) → excluded here (E5 false-positive fix). This exclusion is
  # scoped to the restore decision only, so a compound command that ALSO does
  # e.g. `rm` is still caught by the patterns above.
  if grep -qE 'git[[:space:]]+restore([[:space:]]|$)' <<<"$CMD"; then
    grep -qE '(--staged|(^|[[:space:]])-S([[:space:]]|$))' <<<"$CMD" || return 0
  fi
  return 1
}

if is_destructive; then
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
       touch "$OVERRIDE"    # consumed by the very next Bash command, then re-armed

EOF
  exit 2
fi

exit 0
