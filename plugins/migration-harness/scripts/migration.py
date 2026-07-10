#!/usr/bin/env python3
"""migration.py — deterministic state manager for the migration-harness.

The harness keeps all of its state under `.migration/` at the repo root. Agents
should go through this script rather than hand-editing `manifest.json`, so the
state stays consistent and the audit trail (ledger + snapshots) is never skipped.

Usage:
    migration.py [--root DIR] <command> [options]

Commands:
    init            Create .migration/ and an empty manifest.
    show            Print the full manifest JSON.
    status          Print a short human-readable status summary.
    set-standard    Register a generated project standard (mutating).
    get-standard    Print a registered standard's path (exit 1 if absent).
    set-status      Set the top-level lifecycle status.
    set-strategy    Set transform description / rollback mode / parallelism.
    add-risk        Append an entry to the risk register.
    set-baseline    Record the baseline (suite command + captured flag).
    add-wave        Add a wave.
    add-unit        Add a unit to a wave.
    set-wave-status Set a wave's status.
    set-unit-status Set a unit's status (optionally attach a report path).
    reset-wave      Reset a wave and all its units to pending (for re-planning).
    checkpoint      Snapshot a wave's pre-edit files + record git HEAD.
    list-checkpoints List recorded checkpoints.
    worktree-open   Open a wave's isolated git worktree + branch (worktree mode).
    worktree-path   Print a wave's worktree path (exit 1 if none); read-only.
    integrate       Fast-forward a verified wave's branch into the integration branch.
    rollback        Discard a wave's worktree/branch (worktree mode) or scoped revert.
    check           Run baseline.suite_cmd for a wave; write a suite report.
    record          Record a verification result for a unit (pass/fail + report).
    ledger          Append a line to the human-readable ledger.
    progress        Read-only: at-a-glance derived metrics (phase, waves, units).
    next            Read-only: the deterministic next action (resume directive).

Everything is stdlib-only (json, argparse, subprocess, shutil, pathlib, fcntl,
tempfile, uuid). Requires **Python 3.7+** — the real floor is set by
`from __future__ import annotations` (PEP 563), not the 3.10-style `X | Y` type
hints, which are strings here and never evaluated at runtime.

Safety invariants:
  * All mutating commands take an exclusive `fcntl.flock` on
    `.migration/manifest.lock` and write the manifest via a unique temp file +
    atomic rename, so concurrent transformers/verifiers never lose or corrupt
    each other's writes.
  * `.migration/` is protected state written ONLY by this script; rollback never
    touches, reverts, or deletes anything under it.
  * The verification gate is enforced here, not merely in prose: a wave with a
    non-verified unit cannot be marked verified, and the lifecycle cannot advance
    past an unfinished wave, without an explicit (logged) `--force`.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2
ACTIVE_STATUSES = {
    "assessing",
    "planning",
    "safeguarding",
    "executing",
    "verifying",
    "documenting",
    "cleaning",
}
ALL_STATUSES = ACTIVE_STATUSES | {"done", "rolled-back"}

# A wave's lifecycle. `rollback-failed` is a distinct terminal-bad state: the
# harness tried to discard/revert the wave and git refused, so the tree may be
# half-reverted — the harness must STOP rather than re-checkpoint over it.
WAVE_STATUSES = ("pending", "active", "verified", "rolled-back", "rollback-failed")

# Default execution model. `worktree` gives every wave its own isolated git
# worktree + branch off a dedicated integration branch (transform + verify happen
# there; rollback = discard the worktree; integrate = fast-forward the branch).
# `main-tree` is the legacy model (transform the working tree, snapshot/restore).
EXECUTION_MODELS = ("worktree", "main-tree")

# Git-ignored directories symlinked into each fresh wave worktree so the suite can
# run without a full reinstall (a worktree is a clean checkout with no deps). Only
# those that actually exist in the repo root are linked. Extend via
# `init --link a,b,c` / `set-strategy --link a,b,c`.
DEFAULT_LINK_DIRS = ("node_modules", ".venv", "venv", "vendor", ".yarn", ".bundle")

# The project-specific "standards" generated once by the self-mutating phase
# skills (migrate-profile / -translation-standard / -conventions / -parity-standard).
# `set-standard` accepts arbitrary names (warning on unknown ones) so the skill
# family can grow, but validates against this known set.
KNOWN_STANDARDS = {"profile", "translation", "conventions", "parity"}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s or "item"


def git(root: Path, *args: str, strip: bool = True) -> str | None:
    """Run a git command in `root`; return stdout (stripped unless strip=False),
    or None on failure."""
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=str(root),
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip() if strip else out.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def git_run(root: Path, *args: str) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr) WITHOUT raising
    and WITHOUT swallowing the failure. Use this (not `git()`) anywhere a failure
    must be detected and acted on — worktree/branch/integrate/rollback operations
    — so the harness never reports success on a git error (fixes the audit's
    'rollback swallows every git failure' class)."""
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(root), capture_output=True, text=True
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError:
        return 127, "", "git executable not found on PATH"


def git_available(root: Path) -> bool:
    return git(root, "rev-parse", "--is-inside-work-tree") == "true"


def find_root(explicit: str | None) -> Path:
    # Resolution order is kept IDENTICAL to the guard hook (migration-guard.sh):
    #   explicit --root → MIGRATION_ROOT → CLAUDE_PROJECT_DIR → git toplevel → cwd.
    # If the two disagreed, `.migration/` could be created where the guard never
    # looks, silently disarming it in a nested (non-git-root) project (M6/M17).
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("MIGRATION_ROOT")
    if env:
        return Path(env).resolve()
    proj = os.environ.get("CLAUDE_PROJECT_DIR")
    if proj:
        return Path(proj).resolve()
    top = git(Path.cwd(), "rev-parse", "--show-toplevel")
    if top:
        return Path(top).resolve()
    return Path.cwd()


def mig_dir(root: Path) -> Path:
    return root / ".migration"


def manifest_path(root: Path) -> Path:
    return mig_dir(root) / "manifest.json"


def lock_path(root: Path) -> Path:
    return mig_dir(root) / "manifest.lock"


@contextlib.contextmanager
def manifest_lock(root: Path):
    """Serialize load→mutate→save across concurrent processes.

    An exclusive advisory lock (`fcntl.flock`) is held on
    `.migration/manifest.lock` for the whole critical section so parallel
    transformers/verifiers can't clobber each other's writes (C1/C2).
    """
    lp = lock_path(root)
    lp.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lp, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


def load(root: Path) -> dict:
    p = manifest_path(root)
    if not p.exists():
        die(
            f"No migration found at {p}. Run `migration.py init` first "
            "(from the repo you want to migrate)."
        )
    try:
        raw = p.read_text()
    except OSError as exc:  # pragma: no cover - unusual FS error
        die(f"could not read {p}: {exc}")
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        die(
            f"{p} is not valid JSON ({exc}). The manifest may be corrupt or was "
            "hand-edited mid-write; inspect it or restore it from a checkpoint."
        )
    if not isinstance(data, dict):
        die(f"{p} does not contain a JSON object.")
    # H3: warn (do NOT hard-fail) on a schema mismatch so a forward-compatible
    # read still works. Name both versions so the operator can judge the risk.
    found = data.get("schema")
    if found != SCHEMA_VERSION:
        print(
            f"warning: {p} declares schema version {found!r} but this tool speaks "
            f"schema version {SCHEMA_VERSION}. Reading it anyway; some fields may be "
            "missing or interpreted differently.",
            file=sys.stderr,
        )
    # Back-compat: an older manifest predating the "standards" layer has no such
    # key. Default it to an empty map on read so pre-existing migrations still
    # load (and so every command can assume `manifest["standards"]` is a dict).
    if not isinstance(data.get("standards"), dict):
        data["standards"] = {}
    # Back-compat: a schema-v1 manifest predates the worktree backbone. Default
    # the new strategy fields so it keeps working under the LEGACY main-tree model
    # (no branch/worktrees) rather than silently adopting worktree semantics.
    strat = data.setdefault("strategy", {})
    strat.setdefault("execution", "main-tree")
    strat.setdefault("branch", "")
    strat.setdefault("base_ref", "")
    strat.setdefault("worktree_link", [])
    return data


def save(root: Path, manifest: dict) -> None:
    manifest["updated"] = now()
    p = manifest_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Write to a UNIQUE per-process temp file in the same dir, then atomically
    # rename. A fixed shared temp name would let concurrent writers corrupt each
    # other's partial writes (C2).
    fd, tmp_name = tempfile.mkstemp(dir=str(p.parent), prefix=".manifest.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(manifest, indent=2) + "\n")
        os.replace(tmp_name, p)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def append_ledger(root: Path, line: str) -> None:
    ledger = mig_dir(root) / "ledger.md"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    header = "" if ledger.exists() else "# Migration ledger\n\n"
    with ledger.open("a") as fh:
        fh.write(f"{header}- `{now()}` {line}\n")


def die(msg: str) -> None:
    print(f"migration.py: error: {msg}", file=sys.stderr)
    sys.exit(1)


def find_wave(manifest: dict, wave_id: str) -> dict:
    for w in manifest["waves"]:
        if w["id"] == wave_id:
            return w
    die(f"wave '{wave_id}' not found")


def find_unit(wave: dict, unit_id: str) -> dict:
    for u in wave["units"]:
        if u["id"] == unit_id:
            return u
    die(f"unit '{unit_id}' not found in wave '{wave['id']}'")


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_init(root: Path, args) -> None:
    p = manifest_path(root)
    if p.exists() and not args.force:
        die(f"{p} already exists (use --force to overwrite)")
    if p.exists() and args.force:
        # H4: never clobber an existing plan without a recoverable copy. Back it
        # up alongside the manifest with a UTC-stamped name, then warn about any
        # snapshot dirs the fresh (empty-checkpoints) manifest won't reference.
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        bak = mig_dir(root) / f"manifest.bak-{ts}.json"
        shutil.copy2(p, bak)
        print(f"backed up existing manifest to {bak}", file=sys.stderr)
        append_ledger(root, f"Re-init (--force): backed up previous manifest to `{bak.name}`")
        snaps = mig_dir(root) / "snapshots"
        orphans = (
            sorted(d.name for d in snaps.iterdir() if d.is_dir()) if snaps.is_dir() else []
        )
        if orphans:
            print(
                f"warning: {len(orphans)} existing snapshot dir(s) under {snaps} will be "
                "orphaned by this re-init — the new manifest references none of them: "
                f"{', '.join(orphans)}. Remove them by hand if unwanted.",
                file=sys.stderr,
            )
    head = git(root, "rev-parse", "HEAD")
    have_git = git_available(root)
    if head is None:
        print(
            "warning: no git repo detected. Rollback is far safer with git — "
            "consider `git init` before migrating.",
            file=sys.stderr,
        )

    execution = args.execution
    link_dirs = (
        [d.strip() for d in args.link.split(",") if d.strip()]
        if args.link is not None
        else list(DEFAULT_LINK_DIRS)
    )
    # Worktree execution requires git. Without it, fall back to the legacy
    # main-tree model rather than promising isolation we can't deliver.
    if execution == "worktree" and not have_git:
        print(
            "warning: --execution worktree needs git; no git repo here, so falling "
            "back to --execution main-tree (transform the working tree + snapshots).",
            file=sys.stderr,
        )
        execution = "main-tree"

    branch = ""
    base_ref = ""
    if execution == "worktree":
        base_ref = args.base_ref or git(root, "rev-parse", "--abbrev-ref", "HEAD") or head
        branch = args.branch or f"migration/{slug(args.name)}"
        # A dirty tree at init is fine (we never switch the main tree's branch),
        # but uncommitted work won't be part of the migration — say so once.
        # Ignore `.migration/` itself (the lock dir already exists at this point).
        status = git(root, "status", "--porcelain") or ""
        dirty = [ln for ln in status.splitlines() if ".migration" not in ln]
        if dirty:
            print(
                "warning: the working tree has uncommitted changes. The migration "
                f"operates on committed state ({base_ref}); uncommitted work will not "
                "be included. Commit or stash it first if it should be.",
                file=sys.stderr,
            )
        exists = git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") is not None
        if exists and not args.force:
            die(
                f"integration branch '{branch}' already exists. Choose another with "
                "--branch, or pass --force to reuse it."
            )
        if not exists:
            rc, _, err = git_run(root, "branch", branch, base_ref)
            if rc != 0:
                die(f"could not create integration branch '{branch}' at {base_ref}: {err}")

    manifest = {
        "schema": SCHEMA_VERSION,
        "name": args.name,
        "goal": args.goal or "",
        "status": "assessing",
        "created": now(),
        "updated": now(),
        "strategy": {
            "transform": args.transform or "",
            "rollback": "worktree" if execution == "worktree" else "git+snapshots",
            "parallelism": args.parallelism,
            # Worktree backbone: which execution model, the dedicated integration
            # branch verified waves land on, the ref it forked from, and the
            # git-ignored dep dirs to symlink into each fresh wave worktree.
            "execution": execution,
            "branch": branch,
            "base_ref": base_ref,
            "worktree_link": link_dirs,
        },
        "risk_register": [],
        "baseline": {"captured": False, "suite_cmd": "", "characterization": []},
        "checkpoints": [],
        "waves": [],
        # Project-specific standards generated once by the self-mutating phase
        # skills, keyed by name (profile/translation/conventions/parity). Empty
        # until a skill calls `set-standard`.
        "standards": {},
    }
    save(root, manifest)
    for sub in ("snapshots", "reports", "baseline", "standards", "worktrees"):
        (mig_dir(root) / sub).mkdir(parents=True, exist_ok=True)
    ensure_migration_gitignore(root)
    append_ledger(root, f"Initialized migration **{args.name}**. Goal: {args.goal or '(unset)'}")
    if execution == "worktree":
        append_ledger(
            root,
            f"Worktree backbone: integration branch `{branch}` forked from `{base_ref}`; "
            "each wave transforms + verifies in its own worktree.",
        )
        print(
            f"Initialized migration '{args.name}' at {mig_dir(root)}\n"
            f"  execution: worktree   integration branch: {branch}  (from {base_ref})"
        )
    else:
        print(
            f"Initialized migration '{args.name}' at {mig_dir(root)}\n"
            "  execution: main-tree (legacy)"
        )


def cmd_show(root: Path, args) -> None:
    print(json.dumps(load(root), indent=2))


def cmd_status(root: Path, args) -> None:
    m = load(root)
    print(f"Migration: {m['name']}   status: {m['status']}")
    if m.get("goal"):
        print(f"Goal: {m['goal']}")
    # G8: surface the fan-out cap the skills reference (it was only in `show`).
    strat = m.get("strategy", {})
    print(
        f"Parallelism: {strat.get('parallelism', '?')} "
        "(max transformer/verifier subagents in flight)"
    )
    risks = m.get("risk_register", [])
    high = sum(1 for r in risks if r.get("severity") == "high")
    print(f"Risks: {len(risks)} ({high} high)   Baseline captured: {m['baseline']['captured']}")
    print(f"Checkpoints: {len(m.get('checkpoints', []))}")
    stds = m.get("standards", {})
    print(f"Standards: {', '.join(sorted(stds)) if stds else 'none'}")
    if not m["waves"]:
        print("Waves: none yet")
        return
    print("Waves:")
    for w in m["waves"]:
        counts: dict[str, int] = {}
        for u in w["units"]:
            counts[u["status"]] = counts.get(u["status"], 0) + 1
        summary = ", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "no units"
        gate = "on" if w.get("gate") else "off"
        print(
            f"  - {w['id']} [{w['status']}]  risk={w.get('risk', 'low')} gate={gate}  "
            f"units={len(w['units'])} ({summary})"
        )
        for u in w["units"]:
            line = f"      · {u['id']} [{u['status']}]"
            attempts = int(u.get("attempts", 0) or 0)
            if attempts:
                line += f" attempts={attempts}"
            # G7: only shown when a per-unit override is actually set.
            if u.get("transform"):
                line += f"  transform: {u['transform']}"
            if u.get("success"):
                line += f"  success: {u['success']}"
            print(line)


def cmd_set_standard(root: Path, args) -> None:
    """Register a project-specific standard generated by a self-mutating phase
    skill. The doc itself lives at `.migration/standards/<name>.md`; this records
    where it is (plus the source/target it was generated for) in the manifest so
    later phases can find it via `get-standard`. Arbitrary names are allowed (the
    skill family can grow) but an unknown name warns."""
    if args.name not in KNOWN_STANDARDS:
        print(
            f"warning: '{args.name}' is not a known standard name "
            f"({', '.join(sorted(KNOWN_STANDARDS))}); registering it anyway.",
            file=sys.stderr,
        )
    m = load(root)
    m.setdefault("standards", {})[args.name] = {
        "path": args.path,
        "source": args.source or "",
        "target": args.target or "",
        "generated": now(),
    }
    save(root, m)
    st_note = (
        f" ({args.source or '?'} → {args.target or '?'})"
        if (args.source or args.target)
        else ""
    )
    append_ledger(root, f"Standard **{args.name}** generated{st_note} → `{args.path}`")
    print(f"registered standard '{args.name}' → {args.path}")


def cmd_get_standard(root: Path, args) -> None:
    """Read-only artifact-guard primitive (holds NO lock): if `--name` is
    registered, print its `path` to stdout and exit 0; otherwise print nothing
    and exit 1. Phase skills use this to decide whether to bootstrap a standard:
    `if ! migration.py get-standard --name translation; then …bootstrap… fi`."""
    m = load(root)
    std = m.get("standards", {}).get(args.name)
    if not isinstance(std, dict) or not std.get("path"):
        sys.exit(1)
    print(std["path"])


def _status_precondition(root: Path, m: dict, target: str) -> str | None:
    """Return a human reason why advancing to `target` is not yet allowed, or
    None if the transition is permitted. Enforces the phase ordering (B2/B4)."""
    waves = m.get("waves", [])
    if target == "executing":
        reasons = []
        if not m.get("baseline", {}).get("captured"):
            reasons.append("baseline not captured — run `set-baseline --captured true` first")
        # Rollback is unsafe without git, so refuse to start transforming a
        # non-git tree unless the operator explicitly --forces it (B4).
        if git(root, "rev-parse", "--is-inside-work-tree") != "true":
            reasons.append(
                "not a git repository — rollback is unsafe without git; run `git init` first"
            )
        # Worktree model: the whole backbone (per-wave worktrees, integrate,
        # rollback-by-discard) hangs off the integration branch — refuse to start
        # if it's gone.
        if is_worktree_mode(m):
            intbranch = integration_branch(m)
            if git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{intbranch}") is None:
                reasons.append(
                    f"integration branch '{intbranch}' is missing — re-run `init "
                    "--execution worktree` or create it"
                )
        if reasons:
            return "; ".join(reasons)
    elif target == "documenting":
        bad = [
            w["id"]
            for w in waves
            if w["status"] == "active"
            and any(u["status"] != "verified" for u in w["units"])
        ]
        if bad:
            return f"active wave(s) not fully verified: {', '.join(bad)}"
    elif target in ("cleaning", "done"):
        # Every wave must be verified. A rolled-back / rollback-failed wave no
        # longer counts (F1): it must be reset (`reset-wave`) and re-done, or the
        # whole migration aborted via top-level `set-status rolled-back`.
        bad = [w["id"] for w in waves if w["status"] != "verified"]
        if bad:
            return f"wave(s) not verified: {', '.join(bad)}"
        # Worktree model: a verified wave still living in its worktree hasn't
        # landed on the integration branch — it must be `integrate`d first, or the
        # final branch would be missing that wave's work.
        if is_worktree_mode(m):
            unmerged = [w["id"] for w in waves if not w.get("integrated")]
            if unmerged:
                return (
                    f"wave(s) verified but not integrated: {', '.join(unmerged)} — run "
                    "`integrate --wave <id>` for each before completing"
                )
    return None


def cmd_set_status(root: Path, args) -> None:
    if args.value not in ALL_STATUSES:
        die(f"invalid status '{args.value}'. One of: {', '.join(sorted(ALL_STATUSES))}")
    m = load(root)
    old = m["status"]
    reason = _status_precondition(root, m, args.value)
    if reason:
        if not args.force:
            die(
                f"refusing to set status '{args.value}': {reason}. "
                "Use --force to override (it will be logged)."
            )
        append_ledger(root, f"FORCED status {old} → {args.value} despite: {reason}")
    m["status"] = args.value
    save(root, m)
    append_ledger(root, f"Status: {old} → {args.value}")
    # E6: a completed/aborted migration must not leave a destructive-guard
    # override armed — it would otherwise leak into a reused `.migration/`.
    if args.value in ("done", "rolled-back"):
        override = mig_dir(root) / ".allow-destructive"
        if override.exists():
            try:
                override.unlink()
            except OSError:
                pass
            else:
                append_ledger(
                    root,
                    "Cleared stale destructive-guard override "
                    f"(.migration/.allow-destructive) on status → {args.value}",
                )
    print(f"status: {old} → {args.value}")


def cmd_set_strategy(root: Path, args) -> None:
    m = load(root)
    if args.transform is not None:
        m["strategy"]["transform"] = args.transform
    if args.rollback is not None:
        m["strategy"]["rollback"] = args.rollback
    if args.parallelism is not None:
        m["strategy"]["parallelism"] = args.parallelism
    if getattr(args, "link", None) is not None:
        m["strategy"]["worktree_link"] = [d.strip() for d in args.link.split(",") if d.strip()]
    save(root, m)
    print("strategy updated:", json.dumps(m["strategy"]))


def cmd_add_risk(root: Path, args) -> None:
    if args.severity not in ("low", "med", "high"):
        die("severity must be low|med|high")
    m = load(root)
    rid = args.id or f"risk-{len(m['risk_register']) + 1}"
    # H5: mirror the dup-ID guard add-wave/add-unit already have.
    if any(r.get("id") == rid for r in m["risk_register"]):
        die(f"risk '{rid}' already exists")
    m["risk_register"].append(
        {
            "id": rid,
            "area": args.area,
            "risk": args.risk,
            "severity": args.severity,
            "mitigation": args.mitigation or "",
        }
    )
    save(root, m)
    append_ledger(root, f"Risk [{args.severity}] {rid} in {args.area}: {args.risk}")
    print(f"added {rid}")


def cmd_set_baseline(root: Path, args) -> None:
    m = load(root)
    # Apply suite_cmd / characterization additions BEFORE evaluating a captured
    # request, so a single call (`--suite-cmd X --characterization a,b --captured
    # true`) can satisfy its own preconditions.
    if args.suite_cmd is not None:
        m["baseline"]["suite_cmd"] = args.suite_cmd
    if args.characterization:
        m["baseline"]["characterization"].extend(
            c for c in args.characterization.split(",") if c.strip()
        )
    if args.captured is not None:
        want = args.captured == "true"
        # captured=true is a real claim, not a bare flag (B3): refuse it unless a
        # suite command is set AND every declared characterization artifact exists
        # on disk, so `set-status executing` can trust it.
        if want:
            reasons = []
            if not (m["baseline"].get("suite_cmd") or "").strip():
                reasons.append("suite_cmd is empty (set --suite-cmd)")
            missing = [
                c for c in m["baseline"].get("characterization", [])
                if not (root / c).exists()
            ]
            if missing:
                reasons.append("missing characterization path(s): " + ", ".join(missing))
            if reasons:
                if not args.force:
                    die(
                        "refusing to set captured=true: " + "; ".join(reasons)
                        + ". Capture the baseline artifacts first, or use --force "
                        "(it will be logged)."
                    )
                append_ledger(
                    root, "FORCED baseline captured=true despite: " + "; ".join(reasons)
                )
        m["baseline"]["captured"] = want
    save(root, m)
    print("baseline:", json.dumps(m["baseline"]))


def cmd_add_wave(root: Path, args) -> None:
    if args.risk not in ("low", "med", "high"):
        die("risk must be low|med|high")
    m = load(root)
    wid = args.id or f"wave-{len(m['waves']) + 1}"
    if any(w["id"] == wid for w in m["waves"]):
        die(f"wave '{wid}' already exists")
    m["waves"].append(
        {
            "id": wid,
            "title": args.title or "",
            "status": "pending",
            # F5: persist per-wave risk and the human-gate decision so they
            # survive a resume instead of living only in plan prose. gate=true
            # means "pause for a human before this wave".
            "risk": args.risk,
            "gate": bool(args.gate),
            "checkpoint": "",
            "units": [],
        }
    )
    save(root, m)
    gate_note = ", GATE (human pause)" if args.gate else ""
    append_ledger(root, f"Planned {wid} [risk={args.risk}{gate_note}]: {args.title or ''}")
    print(f"added {wid}")


def cmd_add_unit(root: Path, args) -> None:
    if args.risk not in ("low", "med", "high"):
        die("risk must be low|med|high")
    m = load(root)
    wave = find_wave(m, args.wave)
    uid = args.id or f"{args.wave}-u{len(wave['units']) + 1}"
    if any(u["id"] == uid for u in wave["units"]):
        die(f"unit '{uid}' already exists in {args.wave}")
    wave["units"].append(
        {
            "id": uid,
            "title": args.title or "",
            "paths": [p for p in (args.paths or "").split(",") if p],
            "risk": args.risk,
            "status": "pending",
            "depends_on": [d for d in (args.depends or "").split(",") if d],
            # G1: the per-unit success criterion (what "verified" must prove).
            "success": args.success or "",
            # G7: optional per-unit transform override. When non-empty the execute
            # skill prefers it over the global strategy.transform, so a
            # heterogeneous migration can give one unit a different rule.
            "transform": args.transform or "",
            # F2: verify-fail retry counter (record --result fail increments it)
            # so the execute loop can bound retries.
            "attempts": 0,
            "report": "",
        }
    )
    save(root, m)
    print(f"added {uid} to {args.wave}")


def cmd_set_wave_status(root: Path, args) -> None:
    if args.value not in WAVE_STATUSES:
        die(f"wave status must be one of {WAVE_STATUSES}")
    m = load(root)
    wave = find_wave(m, args.wave)
    # Refuse to mark a wave verified while any of its units is not verified (B2).
    if args.value == "verified":
        unverified = [u["id"] for u in wave["units"] if u["status"] != "verified"]
        if unverified:
            if not args.force:
                die(
                    f"refusing to mark {args.wave} verified: unit(s) not verified: "
                    f"{', '.join(unverified)}. Verify/roll them back, or use --force "
                    "(it will be logged)."
                )
            append_ledger(
                root,
                f"FORCED {args.wave} → verified despite unverified units: "
                f"{', '.join(unverified)}",
            )
    old = wave["status"]
    wave["status"] = args.value
    save(root, m)
    append_ledger(root, f"{args.wave}: {old} → {args.value}")
    print(f"{args.wave}: {old} → {args.value}")


def cmd_set_unit_status(root: Path, args) -> None:
    # G3: `deferred` = a transformer legitimately blocked on a dependency; it is
    # a distinct signal from `pending` that survives a resume.
    valid = (
        "pending", "in-progress", "migrated", "verified", "failed",
        "deferred", "rolled-back",
    )
    if args.value not in valid:
        die(f"unit status must be one of {valid}")
    m = load(root)
    wave = find_wave(m, args.wave)
    unit = find_unit(wave, args.unit)
    old = unit["status"]
    # M15: `verified` is the verification gate's own verdict — it must go through
    # `record` (which stores a report, bumps attempts, and auto-rolls-back on a
    # fail), not a bare status flip that would let an agent walk a unit to verified
    # with no evidence. Require --force (logged) for a direct flip to verified.
    if args.value == "verified" and old != "verified" and not args.force:
        die(
            f"refusing to set {args.unit} directly to 'verified' — that is the "
            "verification gate's verdict. Use `record --result pass` (stores a "
            "report), or pass --force (it will be logged)."
        )
    unit["status"] = args.value
    if args.report:
        unit["report"] = args.report
    save(root, m)
    # Every unit transition is ledgered (previously this command was the one silent
    # side door around the audit trail).
    forced = " (FORCED)" if (args.value == "verified" and old != "verified") else ""
    append_ledger(root, f"{args.wave}/{args.unit}: {old} → {args.value}{forced}")
    print(f"{args.wave}/{args.unit}: {old} → {args.value}")


def cmd_reset_wave(root: Path, args) -> None:
    """Reset a failed/rolled-back wave for re-planning (F1): the wave and ALL of
    its units go back to `pending` so `execute` (which picks `pending` waves)
    will re-run it. `attempts` counters are deliberately preserved so the retry
    bound survives the reset."""
    m = load(root)
    wave = find_wave(m, args.wave)
    old = wave["status"]
    # A `rollback-failed` wave means a previous discard/revert left git in an
    # unknown state; re-planning over it could enshrine a half-reverted tree.
    # Refuse until a human repairs it and clears the flag.
    if old == "rollback-failed" and not args.force:
        die(
            f"{args.wave} is 'rollback-failed' — its worktree/branch could not be "
            "discarded cleanly. Repair git by hand (remove the stale worktree/branch), "
            "then `set-wave-status --wave <id> rolled-back`, before reset-wave. Use "
            "--force only if you are sure the tree is clean (logged)."
        )
    if old == "rollback-failed" and args.force:
        append_ledger(root, f"FORCED reset of rollback-failed wave {args.wave}")
    wave["status"] = "pending"
    for u in wave["units"]:
        u["status"] = "pending"
    save(root, m)
    append_ledger(
        root,
        f"Reset {args.wave}: wave {old} → pending, {len(wave['units'])} unit(s) → pending",
    )
    print(f"reset {args.wave}: wave → pending, {len(wave['units'])} unit(s) → pending")


def _snapshot_files(root: Path, dest: Path, files: list[str]) -> list[str]:
    saved = []
    for rel in files:
        src = root / rel
        if not src.exists() or not src.is_file():
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        saved.append(rel)
    return saved


# --------------------------------------------------------------------------- #
# Worktree backbone (worktree-execution model)
# --------------------------------------------------------------------------- #
def integration_branch(m: dict) -> str:
    """The dedicated branch that verified waves are fast-forwarded onto."""
    return m.get("strategy", {}).get("branch") or f"migration/{slug(m.get('name', ''))}"


def wave_branch(m: dict, wid: str) -> str:
    """The per-wave branch, forked from the integration branch tip for one wave.
    Uses a `--` separator (not `/`) so it stays a SIBLING of the integration
    branch: `migration/api-v2` + `/w1` would collide in git's ref store (a ref
    can't be both a file and a directory), whereas `migration/api-v2--w1` cannot."""
    return f"{integration_branch(m)}--{wid}"


def worktree_dir(root: Path, wid: str) -> Path:
    return mig_dir(root) / "worktrees" / wid


def is_worktree_mode(m: dict) -> bool:
    return m.get("strategy", {}).get("execution") == "worktree"


def ensure_migration_gitignore(root: Path) -> None:
    """Make git ignore everything under `.migration/` (snapshots, worktree
    checkouts, manifest) so wave worktrees and backups never show up as untracked
    churn in the tree being migrated."""
    gi = mig_dir(root) / ".gitignore"
    if not gi.exists():
        gi.parent.mkdir(parents=True, exist_ok=True)
        gi.write_text("# Managed by migration-harness — ignore all harness state.\n*\n")


def link_worktree_deps(root: Path, wt: Path, names: list[str]) -> list[str]:
    """Symlink each existing git-ignored dependency dir (node_modules, .venv, …)
    from the repo root into a fresh wave worktree, so its suite can run without a
    full reinstall. Silently skips ones that don't exist; never overwrites."""
    linked: list[str] = []
    for name in names:
        if not name or name in (".", "..") or os.path.isabs(name) or ".." in Path(name).parts:
            continue
        src = root / name
        dst = wt / name
        if src.exists() and not dst.exists():
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(src.resolve(), dst)
                linked.append(name)
            except OSError as exc:  # pragma: no cover - filesystem specific
                print(f"warning: could not link {name} into worktree: {exc}", file=sys.stderr)
    return linked


# --------------------------------------------------------------------------- #
# Path resolution + rollback machinery
# --------------------------------------------------------------------------- #
PROTECTED_TOP = {".migration", ".git"}


def _is_protected_rel(rel: str) -> bool:
    """True if a repo-relative path lives under protected state we must never
    snapshot, revert, or delete (`.migration/`, `.git/`)."""
    parts = Path(rel).parts
    return bool(parts) and parts[0] in PROTECTED_TOP


def _collect(root: Path, p: Path, into: set) -> None:
    """Add file `p` (or every file under it if it's a directory) to `into` as
    repo-relative posix paths, skipping protected state."""
    if p.is_dir():
        for f in p.rglob("*"):
            if f.is_file():
                rel = f.relative_to(root).as_posix()
                if not _is_protected_rel(rel):
                    into.add(rel)
    elif p.is_file():
        rel = p.relative_to(root).as_posix()
        if not _is_protected_rel(rel):
            into.add(rel)


def _resolve_targets(root: Path, patterns: list[str]) -> tuple[list[str], list[str]]:
    """Expand a list of unit `paths` (files, directories, or globs) into:
      * `present` — repo-relative files that exist right now (to snapshot), and
      * `absent`  — literal (non-glob) target paths that do NOT exist now, so
                    rollback can delete them if a transform creates them.
    Rejects absolute paths and `..` traversal so scope can never escape the repo.
    """
    present: set = set()
    absent: set = set()
    for raw in patterns:
        pat = (raw or "").strip()
        if not pat:
            continue
        if os.path.isabs(pat) or ".." in Path(pat).parts:
            die(f"path '{pat}' must be relative to the repo root and may not contain '..'")
        if any(ch in pat for ch in "*?["):
            for mp in root.glob(pat):
                _collect(root, mp, present)
            # A glob that matches nothing yields no concrete file to track as absent.
        else:
            p = root / pat
            if p.exists():
                _collect(root, p, present)
            elif not _is_protected_rel(pat):
                absent.add(Path(pat).as_posix())
    absent -= present
    return sorted(present), sorted(absent)


def _git_status_targets(root: Path) -> list[str]:
    """Legacy fallback: files that differ from HEAD in the working tree.
    Uses `-z -uall` so untracked directories are expanded and quoted/unicode
    paths survive intact (A2)."""
    raw = git(root, "status", "--porcelain", "-z", "-uall", strip=False)
    if not raw:
        return []
    tokens = raw.split("\0")
    out: list[str] = []
    i = 0
    while i < len(tokens):
        entry = tokens[i]
        if not entry:
            i += 1
            continue
        status = entry[:2]
        path = entry[3:]
        # Rename/copy entries carry a second NUL-separated field (the source).
        if status and status[0] in ("R", "C"):
            i += 1
        if path and not _is_protected_rel(path):
            out.append(path)
        i += 1
    return out


def _wave_patterns(wave: dict | None) -> list[str]:
    pats: list[str] = []
    if wave:
        for u in wave.get("units", []):
            for p in u.get("paths", []):
                if (p or "").strip():
                    pats.append(p.strip())
    return pats


def _safe_pathspec(ps: str) -> str | None:
    """Return a pathspec safe to hand to git checkout/clean, or None to drop it.
    Never allows `.`/root, absolute paths, `..`, or anything under `.migration/`
    — so scoped git operations can never touch protected state (A2)."""
    ps = (ps or "").strip()
    if not ps or ps in (".", "./"):
        return None
    if os.path.isabs(ps) or ".." in Path(ps).parts:
        return None
    if _is_protected_rel(ps):
        return None
    return ps


def _rollback_pathspecs(wave: dict | None, cp: dict) -> list[str]:
    """The scope git operations act on: the wave's unit paths if available,
    otherwise the checkpoint's concrete captured + absent file paths."""
    specs: list[str] = []
    for p in _wave_patterns(wave):
        s = _safe_pathspec(p)
        if s:
            specs.append(s)
    if not specs:
        for p in list(cp.get("files", [])) + list(cp.get("absent", [])):
            s = _safe_pathspec(p)
            if s:
                specs.append(s)
    seen: set = set()
    out: list[str] = []
    for s in specs:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _git_clean_scoped(root: Path, pathspecs: list[str]) -> None:
    if pathspecs:
        git(root, "clean", "-fd", "--", *pathspecs)


def _git_scoped_revert(root: Path, head: str, pathspecs: list[str]) -> None:
    """Scoped true revert: restore tracked (modified/deleted) files to `head`
    and remove untracked files that were created — for these paths ONLY."""
    for ps in pathspecs:
        # Per-pathspec so one non-matching spec can't abort the rest.
        git(root, "checkout", head, "--", ps)
    _git_clean_scoped(root, pathspecs)


def _snapshot_restore(root: Path, cp: dict) -> tuple[list[str], list[str]]:
    """No-git / dirty-checkpoint fallback: copy captured content back (restores
    modified + deleted) and delete now-present files recorded as `absent`
    (removes files a transform created)."""
    snap = mig_dir(root) / "snapshots" / cp["id"] / "files"
    restored: list[str] = []
    for rel in cp.get("files", []):
        src = snap / rel
        if src.exists() and src.is_file():
            dst = root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            restored.append(rel)
    removed: list[str] = []
    for rel in cp.get("absent", []):
        if _is_protected_rel(rel):
            continue
        dst = root / rel
        if dst.exists() and dst.is_file():
            dst.unlink()
            removed.append(rel)
    return restored, removed


def _protect_migration_reset(root: Path, head: str) -> None:
    """`--git-reset`: hard-reset the tree to `head` (reset FIRST, per A3) while
    guaranteeing `.migration/` state survives even if it happens to be tracked."""
    tracked = git(root, "ls-files", "--", ".migration")
    if not tracked:
        git(root, "reset", "--hard", head)
        return
    mig = mig_dir(root)
    holder = Path(tempfile.mkdtemp(prefix=".mig-backup-", dir=str(root)))
    try:
        backup = holder / "migration"
        shutil.copytree(mig, backup)
        git(root, "reset", "--hard", head)
        if mig.exists():
            shutil.rmtree(mig)
        shutil.copytree(backup, mig)
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def _perform_rollback(root: Path, cp: dict, wave: dict | None, git_reset: bool) -> str:
    """True, scoped revert of a checkpoint. Restores modified files, deletes
    files created during the wave, restores deleted files — scoped to the wave's
    paths and NEVER touching `.migration/`. Mutates `wave["status"]` in memory;
    the caller is responsible for `save()`."""
    git_available = git(root, "rev-parse", "--is-inside-work-tree") == "true"
    head = cp.get("git_head")
    pathspecs = _rollback_pathspecs(wave, cp)

    if git_reset:
        if not (git_available and head):
            die("--git-reset requires a git repo and a recorded git_head")
        _protect_migration_reset(root, head)  # reset FIRST, then re-lay below (A3)

    # A clean git_head is the faithful source when the tree was clean at
    # checkpoint. A dirty checkpoint's pre-edit content only lives in the
    # snapshot, so fall back to copy-back there.
    if git_available and head and not cp.get("git_dirty"):
        _git_scoped_revert(root, head, pathspecs)
        summary = f"git scoped revert of {len(pathspecs)} path(s) to {head[:8]}"
    else:
        # Clean FIRST (delete wave-created untracked files), then restore — so a
        # restored file is never deleted by a clean that runs after it. Scope the
        # clean to the checkpoint's LITERAL captured/absent paths, never the wave's
        # raw glob patterns: git expands `*` across `/`, so a glob clean could
        # delete files the checkpoint never captured (unrecoverable).
        if git_available:
            literal: list[str] = []
            for p in list(cp.get("files", [])) + list(cp.get("absent", [])):
                s = _safe_pathspec(p)
                if s:
                    literal.append(s)
            _git_clean_scoped(root, literal)
        restored, removed = _snapshot_restore(root, cp)
        summary = f"snapshot restore ({len(restored)} restored, {len(removed)} removed)"

    if wave is not None:
        wave["status"] = "rolled-back"
    return summary


def cmd_checkpoint(root: Path, args) -> None:
    m = load(root)
    # H2: validate --wave BEFORE any file/git side effect.
    wave = find_wave(m, args.wave) if args.wave else None
    # H5: `--tag` used to silently no-op without `--commit`. A checkpoint tag
    # marks the commit the checkpoint makes, so refuse loudly instead of tagging
    # some unrelated HEAD. Checked before any side effect (H2).
    if args.tag and not args.commit:
        die("--tag requires --commit (the tag marks the commit the checkpoint creates)")

    if args.paths:
        patterns = [p for p in args.paths.split(",") if p.strip()]
        present, absent = _resolve_targets(root, patterns)
    elif wave is not None:
        # Auto-derive the target set from the wave's units' paths (A1): the
        # current pre-edit content of those paths is exactly what rollback
        # must restore, because checkpoints run before the wave transforms code.
        patterns = []
        for u in wave["units"]:
            patterns.extend(u.get("paths", []))
        present, absent = _resolve_targets(root, patterns)
    else:
        # Legacy path (e.g. `checkpoint --label baseline --commit` with no wave):
        # snapshot whatever currently differs from HEAD.
        present = _git_status_targets(root)
        absent = []

    if not present:
        detail = (
            f" (only {len(absent)} not-yet-existing path(s) tracked for deletion-on-rollback)"
            if absent
            else ""
        )
        print(
            "warning: checkpoint captured 0 files" + detail + " — rolling back this "
            "checkpoint would restore no content. Check the wave's unit paths or "
            "pass --paths.",
            file=sys.stderr,
        )

    # H1: unique suffix so two same-second checkpoints can't collide.
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    cid = f"cp-{ts}-{slug(args.label)}-{uuid.uuid4().hex[:6]}"
    snap_dir = mig_dir(root) / "snapshots" / cid / "files"
    snap_dir.mkdir(parents=True, exist_ok=True)

    saved = _snapshot_files(root, snap_dir, present)
    head = git(root, "rev-parse", "HEAD")
    # git_dirty reflects whether the CAPTURED TARGET paths differ from HEAD
    # (modified or untracked) — NOT the whole tree, so an untracked `.migration/`
    # doesn't falsely trip it. When clean, `git checkout HEAD -- <paths>` restores
    # those paths faithfully at rollback; when dirty, only the snapshot holds the
    # pre-edit content, so rollback must copy it back.
    if saved:
        st = git(root, "status", "--porcelain", "-z", "-uall", "--", *saved, strip=False)
        dirty = bool(st and st.replace("\0", "").strip())
    else:
        dirty = bool(git(root, "status", "--porcelain"))

    if args.commit:
        # H7: stage ONLY the checkpoint's own target files (not `git add -A`), so
        # unrelated WIP elsewhere in the tree isn't swept into the migration
        # commit. `.migration/` is excluded via _safe_pathspec.
        commit_specs: list[str] = []
        seen_specs: set = set()
        for rel in saved:
            spec = _safe_pathspec(rel)
            if spec and spec not in seen_specs:
                seen_specs.add(spec)
                commit_specs.append(spec)
        if commit_specs:
            git(root, "add", "--", *commit_specs)
        commit_cmd = ["commit", "-m", f"migration: checkpoint {args.label}"]
        # Pre-commit hooks (secret scanners etc.) run by default; --no-verify is
        # now an explicit opt-in rather than always-on (H7).
        if args.no_verify:
            commit_cmd.append("--no-verify")
        git(root, *commit_cmd)
        if args.tag:
            git(root, "tag", f"migration/{cid}")
        head = git(root, "rev-parse", "HEAD")
        dirty = False

    meta = {
        "id": cid,
        "label": args.label,
        "created": now(),
        "git_head": head,
        "git_dirty": dirty,
        "committed": bool(args.commit),
        "files": saved,
        # Target paths that did NOT exist at checkpoint; rollback deletes them
        # if a transform creates them (A2).
        "absent": absent,
    }
    (mig_dir(root) / "snapshots" / cid / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    m.setdefault("checkpoints", []).append(meta)
    if wave is not None:
        wave["checkpoint"] = cid
    save(root, m)
    append_ledger(
        root,
        f"Checkpoint `{cid}` ({len(saved)} files snapshotted, {len(absent)} absent tracked"
        + (", committed" if args.commit else "")
        + f", HEAD={head[:8] if head else 'none'})",
    )
    print(cid)


def cmd_list_checkpoints(root: Path, args) -> None:
    m = load(root)
    cps = m.get("checkpoints", [])
    if not cps:
        print("no checkpoints")
        return
    for cp in cps:
        print(
            f"{cp['id']}  files={len(cp['files'])}  "
            f"head={(cp['git_head'] or 'none')[:8]}  committed={cp['committed']}"
        )


def cmd_worktree_open(root: Path, args) -> None:
    """Open a wave's isolated worktree + branch (worktree execution model). The
    wave's transformers edit INSIDE this worktree and verify runs its suite there,
    so the main working tree is never touched until `integrate`. Idempotent: a
    wave that already has a live worktree is returned as-is (resume-safe)."""
    m = load(root)
    wave = find_wave(m, args.wave)
    if not is_worktree_mode(m):
        die(
            "worktree-open requires a worktree-execution migration (init --execution "
            f"worktree). This migration uses execution="
            f"{m['strategy'].get('execution')!r}; use `checkpoint --wave` instead."
        )
    if not git_available(root):
        die("worktree-open requires a git repository")

    wid = wave["id"]
    wt = worktree_dir(root, wid)
    branch = wave_branch(m, wid)
    intbranch = integration_branch(m)

    # Resume/idempotence: a live worktree already exists → keep it. Opening again
    # would fork a second branch and orphan any in-progress edits.
    if wave.get("worktree") and (root / wave["worktree"]).exists():
        print(str(root / wave["worktree"]))
        return

    base_sha = git(root, "rev-parse", intbranch)
    if not base_sha:
        die(
            f"integration branch '{intbranch}' not found — was this migration "
            "initialized with `init --execution worktree`?"
        )

    # Clear any stale registration/branch/dir from a previously aborted open.
    git_run(root, "worktree", "prune")
    if git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") is not None:
        git_run(root, "branch", "-D", branch)
    if wt.exists():
        shutil.rmtree(wt, ignore_errors=True)

    wt.parent.mkdir(parents=True, exist_ok=True)
    rc, _, err = git_run(root, "worktree", "add", "-b", branch, str(wt), intbranch)
    if rc != 0:
        die(f"could not create worktree for {wid}: {err}")
    linked = link_worktree_deps(root, wt, m["strategy"].get("worktree_link", []))

    # Belt-and-suspenders: snapshot the wave's pre-edit target files (a backup on
    # top of the branch) and record a checkpoint so `wave['checkpoint']` stays
    # populated and the snapshot fallback in rollback has content. Pre-edit content
    # == the fresh worktree checkout, so snapshot from there.
    patterns: list[str] = []
    for u in wave["units"]:
        patterns.extend(u.get("paths", []))
    present, absent = _resolve_targets(wt, patterns)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    cid = f"cp-{ts}-open-{slug(wid)}-{uuid.uuid4().hex[:6]}"
    snap_dir = mig_dir(root) / "snapshots" / cid / "files"
    snap_dir.mkdir(parents=True, exist_ok=True)
    saved = _snapshot_files(wt, snap_dir, present)
    meta = {
        "id": cid,
        "label": f"open-{wid}",
        "created": now(),
        "git_head": base_sha,
        "git_dirty": False,
        "committed": True,
        "files": saved,
        "absent": absent,
        "worktree": True,
    }
    (mig_dir(root) / "snapshots" / cid / "meta.json").write_text(
        json.dumps(meta, indent=2) + "\n"
    )
    m.setdefault("checkpoints", []).append(meta)

    rel_wt = wt.relative_to(root).as_posix()
    wave["worktree"] = rel_wt
    wave["branch"] = branch
    wave["base"] = base_sha
    wave["checkpoint"] = cid
    save(root, m)
    append_ledger(
        root,
        f"Opened worktree for {wid}: `{rel_wt}` on `{branch}` (from {base_sha[:8]}); "
        f"linked deps: {', '.join(linked) or 'none'}",
    )
    print(str(wt))


def cmd_worktree_path(root: Path, args) -> None:
    """Read-only: print a wave's live worktree path (exit 1 if it has none), so a
    skill can `cd` there or pass it to a transformer. Holds no lock."""
    m = load(root)
    wave = find_wave(m, args.wave)
    wt = wave.get("worktree")
    if not wt:
        sys.exit(1)
    p = root / wt
    if not p.exists():
        sys.exit(1)
    print(str(p))


def cmd_integrate(root: Path, args) -> None:
    """Fast-forward a VERIFIED wave's branch into the integration branch, then
    tear down its worktree. Every git step is checked; on any failure the command
    stops (non-zero) rather than reporting a success that didn't happen."""
    m = load(root)
    wave = find_wave(m, args.wave)
    if not is_worktree_mode(m):
        die("integrate is only for worktree-execution migrations")
    wid = wave["id"]
    if wave.get("integrated"):
        print(f"{wid} already integrated @ {str(wave['integrated'])[:8]}")
        return
    if wave["status"] != "verified":
        if not args.force:
            die(
                f"refusing to integrate {wid}: status is '{wave['status']}', expected "
                "'verified'. Verify the wave first, or pass --force (logged)."
            )
        append_ledger(root, f"FORCED integrate of {wid} despite status '{wave['status']}'")

    wt = root / (wave.get("worktree") or "")
    branch = wave.get("branch")
    intbranch = integration_branch(m)
    if not wave.get("worktree") or not wt.exists():
        die(
            f"{wid} has no live worktree to integrate. If it was already integrated "
            "or discarded, there is nothing to do."
        )

    # Commit any pending edits in the worktree onto the wave branch.
    rc, _, err = git_run(root, "-C", str(wt), "add", "-A")
    if rc != 0:
        die(f"git add failed in worktree: {err}")
    staged_rc, _, _ = git_run(root, "-C", str(wt), "diff", "--cached", "--quiet")
    if staged_rc == 1:  # 1 = there ARE staged changes to commit
        title = (wave.get("title") or "").strip()
        commit = ["-C", str(wt), "commit", "-m", f"migration: wave {wid}{(' — ' + title) if title else ''}"]
        if args.no_verify:
            commit.append("--no-verify")
        rc, _, err = git_run(root, *commit)
        if rc != 0:
            die(f"commit failed in worktree (pre-commit hook rejection? author unset?): {err}")
    elif staged_rc != 0:
        die(f"could not inspect worktree staging state (git diff rc={staged_rc})")

    wave_sha = git(root, "rev-parse", branch)
    int_sha = git(root, "rev-parse", intbranch)
    if not wave_sha or not int_sha:
        die("could not resolve branch tips for integration")
    # Sequential waves ⇒ the integration branch must not have moved since this
    # worktree forked from it, so this is a strict fast-forward.
    anc_rc, _, _ = git_run(root, "merge-base", "--is-ancestor", int_sha, wave_sha)
    if anc_rc != 0:
        die(
            f"'{intbranch}' has advanced since {wid} was opened — not a fast-forward. "
            "Integrate one wave at a time; re-open this wave off the current tip."
        )
    rc, _, err = git_run(root, "branch", "-f", intbranch, wave_sha)
    if rc != 0:
        die(f"could not fast-forward '{intbranch}': {err}")
    # Verify the ref actually moved BEFORE tearing down the worktree.
    if git(root, "rev-parse", intbranch) != wave_sha:
        die(f"integration verification failed: '{intbranch}' did not advance to {wave_sha[:8]}")

    rc, _, err = git_run(root, "worktree", "remove", "--force", str(wt))
    if rc != 0:
        die(
            f"integration merged into '{intbranch}' but worktree removal failed: {err}. "
            f"Remove it by hand (`git worktree remove --force {wt}`), then re-run "
            "integrate to delete the wave branch."
        )
    git_run(root, "branch", "-D", branch)  # its commits now live on intbranch

    wave["integrated"] = wave_sha
    wave["worktree"] = ""
    save(root, m)
    append_ledger(
        root,
        f"Integrated {wid} → `{intbranch}` @ {wave_sha[:8]} (worktree removed, branch merged)",
    )
    print(f"integrated {wid} → {intbranch} @ {wave_sha[:8]}")


def _rollback_worktree(root: Path, wave: dict) -> tuple[str, bool]:
    """Discard a wave's worktree + branch — the worktree-model rollback. Because
    the integration branch never received the wave, this is total and safe. Every
    git step is checked; returns (summary, ok). On failure the wave is set to
    `rollback-failed` and the caller must STOP."""
    wt = root / (wave.get("worktree") or "")
    branch = wave.get("branch")
    errors: list[str] = []
    if wave.get("worktree"):
        if wt.exists():
            rc, _, err = git_run(root, "worktree", "remove", "--force", str(wt))
            if rc != 0:
                git_run(root, "worktree", "prune")
                if wt.exists():
                    errors.append(f"worktree remove: {err or 'still present'}")
        git_run(root, "worktree", "prune")
    if branch and git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") is not None:
        rc, _, err = git_run(root, "branch", "-D", branch)
        if rc != 0:
            errors.append(f"branch -D {branch}: {err}")
    if errors:
        wave["status"] = "rollback-failed"
        return "; ".join(errors), False
    wave["worktree"] = ""
    wave["status"] = "rolled-back"
    return "discarded worktree + branch (integration branch untouched)", True


def cmd_rollback(root: Path, args) -> None:
    m = load(root)

    # Worktree model: discarding the wave's worktree + branch IS the rollback.
    # The integration branch never received the wave, so this is a true, total,
    # instantaneous revert with no snapshot/glob/clean machinery to get wrong.
    if args.wave and is_worktree_mode(m):
        wave = find_wave(m, args.wave)
        if wave.get("worktree") or wave.get("branch"):
            summary, ok = _rollback_worktree(root, wave)
            save(root, m)
            if not ok:
                append_ledger(
                    root,
                    f"ROLLBACK FAILED for {args.wave}: {summary}. Wave left "
                    "'rollback-failed' — STOP, repair git by hand, do NOT re-checkpoint over it.",
                )
                print(
                    f"rollback FAILED for {args.wave}: {summary} — wave marked "
                    "'rollback-failed'; do not proceed",
                    file=sys.stderr,
                )
                sys.exit(1)
            append_ledger(root, f"Rolled back {args.wave} — {summary}")
            print(f"rolled back {args.wave} — {summary}")
            return
        # No live worktree (never opened) → fall through to the snapshot path.

    cps = m.get("checkpoints", [])
    if not cps:
        die("no checkpoints to roll back to")

    # Select the checkpoint. Default `rollback --wave W` uses THAT wave's own
    # recorded checkpoint, not merely the latest one (A4).
    wave = None
    if args.to:
        cp = next((c for c in cps if c["id"] == args.to), None)
        if cp is None:
            die(f"checkpoint '{args.to}' not found")
        if args.wave:
            wave = find_wave(m, args.wave)
    elif args.wave:
        wave = find_wave(m, args.wave)
        cid = wave.get("checkpoint")
        if not cid:
            die(f"wave '{args.wave}' has no checkpoint recorded; nothing to roll back to")
        cp = next((c for c in cps if c["id"] == cid), None)
        if cp is None:
            die(f"checkpoint '{cid}' recorded on wave '{args.wave}' not found")
    else:
        cp = cps[-1]

    summary = _perform_rollback(root, cp, wave, args.git_reset)
    save(root, m)
    append_ledger(
        root,
        f"Rolled back {args.wave or ''} to `{cp['id']}` — {summary}".replace("  ", " ")
        + (" + git reset --hard" if args.git_reset else ""),
    )
    print(f"rolled back {args.wave or ''} to {cp['id']} — {summary}".replace("  ", " ").strip())


def cmd_check(root: Path, args) -> None:
    """Mechanical grounding for verify (B3): run `baseline.suite_cmd` in the repo
    root, capture the exit code + output into `.migration/reports/<W>/_suite.md`,
    print PASS/FAIL, and exit non-zero if the suite failed. This does NOT mutate
    the manifest (so it needn't hold the lock while the suite runs); the
    adversarial verdict still goes through `record`."""
    m = load(root)
    wave = find_wave(m, args.wave)  # validate the wave exists before writing a report
    suite = (m.get("baseline", {}) or {}).get("suite_cmd", "") or ""
    # Worktree model: the migrated code lives in the wave's worktree, so the suite
    # must run THERE — running it in the main tree would test the un-migrated code
    # and report a green no-op. Fall back to the repo root (legacy main-tree model,
    # or a wave already integrated).
    run_dir = root
    wt = wave.get("worktree")
    if wt and (root / wt).exists():
        run_dir = root / wt
    reports_dir = mig_dir(root) / "reports" / args.wave
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_file = reports_dir / "_suite.md"
    rel = report_file.relative_to(root)

    if not suite.strip():
        report_file.write_text(
            f"# Suite check — {args.wave}\n\n"
            f"- Recorded: {now()}\n"
            "- Result: **no suite configured**\n\n"
            "No `baseline.suite_cmd` is set, so nothing was run. Configure it with "
            "`set-baseline --suite-cmd '<cmd>'` to give verify a mechanical grounding.\n"
        )
        print(
            f"no suite configured (baseline.suite_cmd is empty) — nothing to run "
            f"for {args.wave}; wrote {rel}"
        )
        return  # exit 0: an unconfigured suite is a notice, not a crash

    proc = subprocess.run(
        suite, shell=True, cwd=str(run_dir), capture_output=True, text=True
    )
    passed = proc.returncode == 0
    verdict = "PASS" if passed else "FAIL"
    where = "worktree " + wt if run_dir != root else "repo root"
    report_file.write_text(
        f"# Suite check — {args.wave}\n\n"
        f"- Command: `{suite}`\n"
        f"- Ran in: {where}\n"
        f"- Recorded: {now()}\n"
        f"- Exit code: {proc.returncode}\n"
        f"- Result: **{verdict}**\n\n"
        f"## stdout\n\n```\n{proc.stdout}```\n\n"
        f"## stderr\n\n```\n{proc.stderr}```\n"
    )
    append_ledger(
        root, f"Suite check {args.wave}: **{verdict}** (exit {proc.returncode}) → {rel}"
    )
    print(f"{verdict} — {args.wave} suite exit {proc.returncode} → {rel}")
    if not passed:
        sys.exit(1)


def cmd_record(root: Path, args) -> None:
    if args.result not in ("pass", "fail"):
        die("result must be pass|fail")
    m = load(root)
    # H2: validate --wave/--unit BEFORE writing any report.
    wave = find_wave(m, args.wave)
    unit = find_unit(wave, args.unit)

    reports_dir = mig_dir(root) / "reports" / args.wave
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_file = reports_dir / f"{args.unit}.md"
    body = args.note or ""
    if args.report and Path(args.report).exists():
        body = Path(args.report).read_text()
    report_file.write_text(
        f"# Verification report — {args.wave}/{args.unit}\n\n"
        f"- Result: **{args.result}**\n- Recorded: {now()}\n\n{body}\n"
    )
    unit["status"] = "verified" if args.result == "pass" else "failed"
    unit["report"] = str(report_file.relative_to(root))
    append_ledger(root, f"Verify {args.wave}/{args.unit}: **{args.result}** ({report_file.name})")

    rolled = False
    if args.result == "fail":
        # F2: bump the retry counter so the execute loop can bound retries.
        unit["attempts"] = int(unit.get("attempts", 0) or 0) + 1
        # A red gate: the migration is not advanceable past this wave. The
        # gate refusals in set-wave-status/set-status enforce that; here we also
        # auto-roll-back the wave to its pre-wave checkpoint (B1) unless the
        # caller opts out with --no-rollback.
        append_ledger(
            root, f"GATE RED: {args.wave}/{args.unit} failed — wave is not advanceable"
        )
        cid = wave.get("checkpoint")
        if args.no_rollback:
            pass
        elif is_worktree_mode(m) and (wave.get("worktree") or wave.get("branch")):
            # Worktree model: auto-rollback = discard the wave's worktree + branch
            # (the same total, safe revert `rollback --wave` performs). Never fall
            # through to the snapshot path, which would leave the worktree/branch
            # orphaned.
            summary, ok = _rollback_worktree(root, wave)
            if ok:
                append_ledger(
                    root, f"Auto-rollback of {args.wave} on failed gate — {summary}"
                )
                rolled = True
            else:
                append_ledger(
                    root,
                    f"AUTO-ROLLBACK FAILED for {args.wave}: {summary} — wave left "
                    "'rollback-failed'; STOP and repair git by hand",
                )
        elif not cid:
            append_ledger(
                root,
                f"WARNING: {args.wave} has no checkpoint — cannot auto-roll-back; "
                "wave left with a failed unit",
            )
        else:
            cp = next((c for c in m.get("checkpoints", []) if c["id"] == cid), None)
            if cp is None:
                append_ledger(
                    root,
                    f"WARNING: checkpoint '{cid}' for {args.wave} missing — cannot auto-roll-back",
                )
            else:
                summary = _perform_rollback(root, cp, wave, git_reset=False)
                append_ledger(
                    root,
                    f"Auto-rollback of {args.wave} to `{cid}` on failed gate — {summary}",
                )
                rolled = True

    save(root, m)
    msg = f"recorded {args.result} for {args.wave}/{args.unit} → {report_file}"
    if args.result == "fail":
        msg += " [wave auto-rolled-back]" if rolled else " [wave NOT advanceable]"
    print(msg)


def cmd_ledger(root: Path, args) -> None:
    append_ledger(root, args.message)
    print("appended to ledger")


# --------------------------------------------------------------------------- #
# Derived views — progress + the deterministic `next` driver
#
# These read-only functions turn the manifest into (a) at-a-glance metrics and
# (b) THE single next action, so a fresh session (human or agent) that inherits a
# half-finished migration can recover from durable state alone — no chat memory.
# The TUI (scripts/migration_tui.py) renders exactly these; `next`/`progress`
# expose them to the orchestrator skill.
# --------------------------------------------------------------------------- #
PHASE_ORDER = [
    "assessing", "planning", "safeguarding", "executing",
    "verifying", "documenting", "cleaning", "done",
]


def read_manifest(root: Path):
    """Non-fatal load: return the manifest dict, or None if there is no migration
    / it can't be read. Unlike load(), never exits — for the TUI and other
    read-only consumers that must degrade gracefully."""
    p = manifest_path(root)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("standards"), dict):
        data["standards"] = {}
    data.setdefault("strategy", {})
    return data


def recent_ledger(root: Path, n: int = 12) -> list[str]:
    """The last n ledger entries (newest last), stripped of markdown noise."""
    ledger = mig_dir(root) / "ledger.md"
    if not ledger.exists():
        return []
    lines = [ln.rstrip("\n") for ln in ledger.read_text().splitlines()]
    entries = [ln for ln in lines if ln.startswith("- ")]
    return entries[-n:]


def compute_progress(m: dict) -> dict:
    """At-a-glance metrics derived from the manifest."""
    waves = m.get("waves", [])
    wave_counts = {"total": len(waves)}
    for key in ("pending", "active", "verified", "rolled-back", "rollback-failed"):
        wave_counts[key] = sum(1 for w in waves if w.get("status") == key)
    wave_counts["integrated"] = sum(1 for w in waves if w.get("integrated"))
    unit_by_status: dict[str, int] = {}
    total_units = 0
    attempts_total = 0
    for w in waves:
        for u in w.get("units", []):
            total_units += 1
            unit_by_status[u["status"]] = unit_by_status.get(u["status"], 0) + 1
            attempts_total += int(u.get("attempts", 0) or 0)
    status = m.get("status", "")
    try:
        phase_index = PHASE_ORDER.index(status)
    except ValueError:
        phase_index = -1  # rolled-back or unknown — off the linear rail
    strat = m.get("strategy", {})
    risks = m.get("risk_register", [])
    return {
        "name": m.get("name", ""),
        "goal": m.get("goal", ""),
        "status": status,
        "phase_index": phase_index,
        "phases": PHASE_ORDER,
        "execution": strat.get("execution", "main-tree"),
        "branch": strat.get("branch", ""),
        "parallelism": strat.get("parallelism"),
        "baseline_captured": bool(m.get("baseline", {}).get("captured")),
        "standards": sorted(m.get("standards", {})),
        "checkpoints": len(m.get("checkpoints", [])),
        "risks": {
            "total": len(risks),
            "high": sum(1 for r in risks if r.get("severity") == "high"),
        },
        "waves": wave_counts,
        "units": {"total": total_units, "by_status": unit_by_status},
        "attempts_total": attempts_total,
        "updated": m.get("updated", ""),
    }


def _status_by_uid(m: dict) -> dict:
    return {u["id"]: u["status"] for w in m.get("waves", []) for u in w.get("units", [])}


def _next_pending_wave(m: dict):
    """First `pending` wave (in order) whose units' cross-wave `depends_on` are
    all already `verified` — the same rule execute uses to pick a wave."""
    by_uid = _status_by_uid(m)
    for w in m.get("waves", []):
        if w.get("status") != "pending":
            continue
        ready = all(
            by_uid.get(dep) == "verified"
            for u in w.get("units", [])
            for dep in u.get("depends_on", [])
        )
        if ready:
            return w
    return None


def _first(seq, pred):
    for x in seq:
        if pred(x):
            return x
    return None


def compute_next(m: dict) -> dict:
    """THE single next action, computed deterministically from manifest state.
    Encodes the orchestration decision tree the skills follow, so resume is a
    state read rather than a reconstruction. Returns:
      {action, reason, wave, skill, hint, severity, commands[]}
    severity: info | warn | critical. commands: literal next steps to run."""
    def out(action, reason, commands=None, wave=None, skill=None, hint=None, severity="info"):
        return {
            "action": action, "reason": reason, "wave": wave, "skill": skill,
            "hint": hint, "severity": severity, "commands": commands or [],
        }

    waves = m.get("waves", [])
    status = m.get("status", "")

    # Terminal-bad state wins over everything: a wave whose rollback git-failed.
    rf = _first(waves, lambda w: w.get("status") == "rollback-failed")
    if rf:
        return out(
            "repair", f"wave {rf['id']} is rollback-failed — git may be half-reverted",
            wave=rf["id"], severity="critical",
            hint="repair git by hand (remove the stale worktree/branch), then set-wave-status rolled-back",
            commands=["git worktree list", f"migration.py set-wave-status --wave {rf['id']} rolled-back"],
        )
    if status == "rolled-back":
        return out("aborted", "the migration was aborted (set-status rolled-back)", severity="warn")
    if status == "done":
        return out(
            "done", "migration complete — review and merge the integration branch",
            commands=[f"git log --oneline {m.get('strategy', {}).get('branch', '')}".strip()],
        )
    if status == "assessing":
        return out("assess", "inventory the migration sites and map dependencies",
                   skill="migrate-assess", commands=["/migration-harness:migrate-assess"])
    if status == "planning":
        return out("plan", "order the work into small waves with success criteria + gates",
                   skill="migrate-plan", commands=["/migration-harness:migrate-plan"])
    if status == "safeguarding":
        return out("safeguard", "capture the behavioral baseline before transforming",
                   skill="migrate-safeguard", commands=["/migration-harness:migrate-safeguard"])
    if status == "executing":
        active = _first(waves, lambda w: w.get("status") == "active")
        if active:
            wid = active["id"]
            units = active.get("units", [])
            if not active.get("worktree"):
                return out("open-worktree", f"wave {wid} is active but has no worktree yet",
                           wave=wid, skill="migrate-execute",
                           commands=[f"migration.py worktree-open --wave {wid}"])
            inprog = [u["id"] for u in units if u["status"] == "in-progress"]
            if inprog:
                return out(
                    "resume-wave",
                    f"wave {wid} has in-progress unit(s) {', '.join(inprog)} — a transformer "
                    "started but never recorded migrated",
                    wave=wid, skill="migrate-execute", severity="warn",
                    hint=f"re-attach the worktree ({active.get('worktree')}); DIFF each in-progress "
                         "unit before re-dispatching — a non-idempotent transform would double-apply",
                    commands=[f"migration.py worktree-path --wave {wid}"],
                )
            pending_u = [u["id"] for u in units if u["status"] == "pending"]
            if pending_u:
                return out("transform", f"wave {wid} worktree open — transform unit(s): {', '.join(pending_u)}",
                           wave=wid, skill="migrate-execute",
                           commands=[f"migration.py worktree-path --wave {wid}"])
            return out("verify", f"wave {wid} fully transformed — hand off to verify",
                       wave=wid, skill="migrate-verify",
                       commands=["migration.py set-status verifying", "/migration-harness:migrate-verify"])
        nxt = _next_pending_wave(m)
        if nxt:
            return out("execute-wave", f"start the next wave: {nxt['id']}", wave=nxt["id"],
                       skill="migrate-execute",
                       commands=[f"migration.py set-wave-status --wave {nxt['id']} active",
                                 "/migration-harness:migrate-execute"])
        rb = _first(waves, lambda w: w.get("status") == "rolled-back")
        if rb:
            return out("reset-wave", f"wave {rb['id']} was rolled back — reset it to redo, or abort the migration",
                       wave=rb["id"], severity="warn",
                       commands=[f"migration.py reset-wave --wave {rb['id']}", "migration.py set-status rolled-back"])
        unmerged = _first(waves, lambda w: w.get("status") == "verified" and not w.get("integrated"))
        if unmerged:
            return out("integrate", f"wave {unmerged['id']} verified but not integrated", wave=unmerged["id"],
                       commands=[f"migration.py integrate --wave {unmerged['id']}"])
        if waves and all(w.get("integrated") for w in waves):
            return out("advance", "all waves integrated — move to cleanup",
                       commands=["migration.py set-status cleaning", "/migration-harness:migrate-cleanup"])
        return out("plan-more", "no wave is active or pending — plan the next waves, or finish",
                   skill="migrate-plan")
    if status == "verifying":
        active = (
            _first(waves, lambda w: w.get("status") == "active")
            or _first(waves, lambda w: any(u["status"] == "migrated" for u in w.get("units", [])))
        )
        if active:
            wid = active["id"]
            failed = [u["id"] for u in active.get("units", []) if u["status"] == "failed"]
            if failed:
                return out("recover", f"unit(s) {', '.join(failed)} failed verify in {wid} — the wave was rolled "
                           "back; reset it to redo (or abort)", wave=wid, severity="warn", skill="migrate-verify",
                           commands=[f"migration.py reset-wave --wave {wid}"])
            unver = [u["id"] for u in active.get("units", []) if u["status"] != "verified"]
            if unver:
                return out("verify", f"verify wave {wid}: run the suite in its worktree, dispatch adversarial "
                           f"verifiers, record each unit ({', '.join(unver)} left)", wave=wid, skill="migrate-verify",
                           commands=[f"migration.py check --wave {wid}", f"migration.py worktree-path --wave {wid}"])
            if active.get("status") != "verified":
                return out("verify-wave", f"all units of {wid} verified — mark the wave verified, then integrate",
                           wave=wid, commands=[f"migration.py set-wave-status --wave {wid} verified",
                                               f"migration.py integrate --wave {wid}"])
            if not active.get("integrated"):
                return out("integrate", f"wave {wid} verified — integrate it into the branch", wave=wid,
                           commands=[f"migration.py integrate --wave {wid}"])
        # A wave verified but not yet integrated (e.g. set-wave-status verified ran
        # but integrate didn't) — integrate before documenting.
        unmerged = _first(waves, lambda w: w.get("status") == "verified" and not w.get("integrated"))
        if unmerged:
            return out("integrate", f"wave {unmerged['id']} verified — integrate it into the branch",
                       wave=unmerged["id"], commands=[f"migration.py integrate --wave {unmerged['id']}"])
        return out("document", "verification complete — document the wave",
                   skill="migrate-document",
                   commands=["migration.py set-status documenting", "/migration-harness:migrate-document"])
    if status == "documenting":
        nxt = _next_pending_wave(m)
        if nxt:
            return out("next-wave", f"documented — take the next wave: {nxt['id']}", wave=nxt["id"],
                       commands=["migration.py set-status executing",
                                 f"migration.py set-wave-status --wave {nxt['id']} active"])
        return out("cleanup", "all waves done — move to the final cleanup phase",
                   commands=["migration.py set-status cleaning", "/migration-harness:migrate-cleanup"])
    if status == "cleaning":
        return out("cleanup", "remove dead code / shims in a final cleanup wave, then finish",
                   skill="migrate-cleanup", commands=["/migration-harness:migrate-cleanup"])
    return out("unknown", f"unrecognized status {status!r}", severity="warn")


def cmd_progress(root: Path, args) -> None:
    m = load(root)
    prog = compute_progress(m)
    if args.json:
        print(json.dumps(prog, indent=2))
        return
    w = prog["waves"]
    print(f"{prog['name']}  [{prog['status']}]   {prog['execution']} → {prog['branch'] or '(no branch)'}")
    if prog["goal"]:
        print(f"  goal: {prog['goal']}")
    idx = prog["phase_index"]
    strip = "  ".join(
        (f"[{p}]" if i == idx else p) for i, p in enumerate(prog["phases"])
    )
    print(f"  phase: {strip}")
    print(
        f"  waves: {w['verified']}/{w['total']} verified, {w['integrated']} integrated, "
        f"{w['active']} active, {w['pending']} pending, {w['rolled-back']} rolled-back"
        + (f", {w['rollback-failed']} ROLLBACK-FAILED" if w["rollback-failed"] else "")
    )
    u = prog["units"]
    by = ", ".join(f"{k}:{v}" for k, v in sorted(u["by_status"].items())) or "none"
    print(f"  units: {u['total']} ({by})   attempts spent: {prog['attempts_total']}")
    print(
        f"  baseline: {'captured' if prog['baseline_captured'] else 'NOT captured'}   "
        f"standards: {', '.join(prog['standards']) or 'none'}   "
        f"checkpoints: {prog['checkpoints']}   risks: {prog['risks']['total']} ({prog['risks']['high']} high)"
    )


def cmd_next(root: Path, args) -> None:
    m = load(root)
    nxt = compute_next(m)
    if args.json:
        print(json.dumps(nxt, indent=2))
        return
    tag = {"info": "Next", "warn": "Next (attention)", "critical": "STOP"}[nxt["severity"]]
    print(f"{tag}: {nxt['action']} — {nxt['reason']}")
    if nxt.get("wave"):
        print(f"  wave: {nxt['wave']}")
    if nxt.get("hint"):
        print(f"  hint: {nxt['hint']}")
    if nxt.get("commands"):
        print("  run:")
        for c in nxt["commands"]:
            print(f"    {c}")


# --------------------------------------------------------------------------- #
# CLI wiring
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="migration.py", description=__doc__)
    p.add_argument("--root", help="Repo root (defaults to git toplevel or cwd)")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("init", help="Create .migration/ and an empty manifest")
    s.add_argument("--name", required=True)
    s.add_argument("--goal", default="")
    s.add_argument("--transform", default="")
    s.add_argument("--parallelism", type=int, default=4)
    s.add_argument(
        "--execution", choices=EXECUTION_MODELS, default="worktree",
        help="worktree (default): per-wave isolated worktree+branch off a dedicated "
        "integration branch; main-tree: legacy in-place transform + snapshots",
    )
    s.add_argument(
        "--branch",
        help="integration branch name (worktree mode; default migration/<name>)",
    )
    s.add_argument(
        "--base-ref",
        help="ref the integration branch forks from (worktree mode; default current branch)",
    )
    s.add_argument(
        "--link",
        help="comma-separated git-ignored dep dirs to symlink into each wave worktree "
        f"(default: {','.join(DEFAULT_LINK_DIRS)})",
    )
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_init, mutates=True)

    sub.add_parser("show", help="Print the full manifest").set_defaults(func=cmd_show)
    sub.add_parser("status", help="Print a short status summary").set_defaults(func=cmd_status)

    s = sub.add_parser("set-standard", help="Register a generated project standard")
    s.add_argument(
        "--name", required=True,
        help="profile|translation|conventions|parity (other names allowed, with a warning)",
    )
    s.add_argument("--path", required=True, help="path to the generated standard doc")
    s.add_argument("--source", help="source stack/language the standard was generated for")
    s.add_argument("--target", help="target stack/language the standard was generated for")
    s.set_defaults(func=cmd_set_standard, mutates=True)

    s = sub.add_parser(
        "get-standard",
        help="Print a registered standard's path (exit 1 if absent); read-only, no lock",
    )
    s.add_argument("--name", required=True)
    s.set_defaults(func=cmd_get_standard)

    s = sub.add_parser("set-status", help="Set top-level lifecycle status")
    s.add_argument("value")
    s.add_argument("--force", action="store_true", help="bypass phase preconditions (logged)")
    s.set_defaults(func=cmd_set_status, mutates=True)

    s = sub.add_parser("set-strategy", help="Set transform/rollback/parallelism/link")
    s.add_argument("--transform")
    s.add_argument("--rollback")
    s.add_argument("--parallelism", type=int)
    s.add_argument(
        "--link",
        help="comma-separated git-ignored dep dirs to symlink into future wave worktrees",
    )
    s.set_defaults(func=cmd_set_strategy, mutates=True)

    s = sub.add_parser("add-risk", help="Append to the risk register")
    s.add_argument("--area", required=True)
    s.add_argument("--risk", required=True)
    s.add_argument("--severity", required=True, help="low|med|high")
    s.add_argument("--mitigation", default="")
    s.add_argument("--id")
    s.set_defaults(func=cmd_add_risk, mutates=True)

    s = sub.add_parser("set-baseline", help="Record baseline suite/flags")
    s.add_argument("--suite-cmd", dest="suite_cmd")
    s.add_argument("--captured", choices=["true", "false"])
    s.add_argument("--characterization", help="comma-separated paths to add")
    s.add_argument(
        "--force", action="store_true",
        help="allow captured=true even if suite_cmd unset or artifacts missing (logged)",
    )
    s.set_defaults(func=cmd_set_baseline, mutates=True)

    s = sub.add_parser("add-wave", help="Add a wave")
    s.add_argument("--id")
    s.add_argument("--title", default="")
    s.add_argument("--risk", default="low", help="low|med|high")
    s.add_argument(
        "--gate", action="store_true",
        help="pause for a human before this wave",
    )
    s.set_defaults(func=cmd_add_wave, mutates=True)

    s = sub.add_parser("add-unit", help="Add a unit to a wave")
    s.add_argument("--wave", required=True)
    s.add_argument("--id")
    s.add_argument("--title", default="")
    s.add_argument("--paths", help="comma-separated file/glob paths")
    s.add_argument("--risk", default="low", help="low|med|high")
    s.add_argument("--depends", help="comma-separated unit ids")
    s.add_argument(
        "--success", default="",
        help="the per-unit success criterion (what 'verified' must prove)",
    )
    s.add_argument(
        "--transform", default="",
        help="per-unit transform override (default: use the global strategy.transform)",
    )
    s.set_defaults(func=cmd_add_unit, mutates=True)

    s = sub.add_parser("set-wave-status", help="Set a wave's status")
    s.add_argument("--wave", required=True)
    s.add_argument("value", help="pending|active|verified|rolled-back")
    s.add_argument(
        "--force", action="store_true",
        help="allow marking verified with unverified units (logged)",
    )
    s.set_defaults(func=cmd_set_wave_status, mutates=True)

    s = sub.add_parser("set-unit-status", help="Set a unit's status")
    s.add_argument("--wave", required=True)
    s.add_argument("--unit", required=True)
    s.add_argument(
        "value",
        help="pending|in-progress|migrated|verified|failed|deferred|rolled-back",
    )
    s.add_argument("--report")
    s.add_argument(
        "--force", action="store_true",
        help="allow a direct flip to 'verified' (bypasses `record`; logged)",
    )
    s.set_defaults(func=cmd_set_unit_status, mutates=True)

    s = sub.add_parser(
        "reset-wave", help="Reset a wave and all its units to pending (re-planning)"
    )
    s.add_argument("--wave", required=True)
    s.set_defaults(func=cmd_reset_wave, mutates=True)

    s = sub.add_parser("checkpoint", help="Snapshot files + record git HEAD")
    s.add_argument("--label", default="checkpoint")
    s.add_argument(
        "--paths",
        help="comma-separated paths (default: auto-derive from --wave's unit paths)",
    )
    s.add_argument("--wave", help="attach to a wave and auto-derive its target paths")
    s.add_argument("--commit", action="store_true", help="also git commit current state")
    s.add_argument(
        "--no-verify", action="store_true",
        help="skip pre-commit hooks on --commit (default: run them)",
    )
    s.add_argument(
        "--tag", action="store_true",
        help="tag the commit migration/<id> (requires --commit)",
    )
    s.set_defaults(func=cmd_checkpoint, mutates=True)

    sub.add_parser("list-checkpoints", help="List checkpoints").set_defaults(
        func=cmd_list_checkpoints
    )

    s = sub.add_parser(
        "worktree-open",
        help="Open a wave's isolated worktree + branch (worktree execution model)",
    )
    s.add_argument("--wave", required=True)
    s.set_defaults(func=cmd_worktree_open, mutates=True)

    s = sub.add_parser(
        "worktree-path", help="Print a wave's worktree path (exit 1 if none); read-only"
    )
    s.add_argument("--wave", required=True)
    s.set_defaults(func=cmd_worktree_path)

    s = sub.add_parser(
        "integrate",
        help="Fast-forward a verified wave's branch into the integration branch",
    )
    s.add_argument("--wave", required=True)
    s.add_argument(
        "--force", action="store_true",
        help="integrate even if the wave is not 'verified' (logged)",
    )
    s.add_argument(
        "--no-verify", action="store_true",
        help="skip pre-commit hooks when committing the worktree",
    )
    s.set_defaults(func=cmd_integrate, mutates=True)

    s = sub.add_parser("check", help="Run baseline.suite_cmd for a wave (mechanical verify)")
    s.add_argument("--wave", required=True)
    s.set_defaults(func=cmd_check)

    s = sub.add_parser("rollback", help="True scoped revert of a wave to its checkpoint")
    s.add_argument("--to", help="checkpoint id (default: the wave's own checkpoint, else latest)")
    s.add_argument("--wave", help="revert this wave to its own checkpoint; mark it rolled-back")
    s.add_argument(
        "--git-reset", action="store_true",
        help="also hard-reset tracked files to the recorded HEAD (.migration/ preserved)",
    )
    s.set_defaults(func=cmd_rollback, mutates=True)

    s = sub.add_parser("record", help="Record a verification result for a unit")
    s.add_argument("--wave", required=True)
    s.add_argument("--unit", required=True)
    s.add_argument("--result", required=True, help="pass|fail")
    s.add_argument("--report", help="path to a report file to store")
    s.add_argument("--note", help="inline note if no report file")
    s.add_argument(
        "--no-rollback", action="store_true",
        help="on fail, mark the unit failed but do NOT auto-roll-back the wave",
    )
    s.set_defaults(func=cmd_record, mutates=True)

    s = sub.add_parser("ledger", help="Append a line to the ledger")
    s.add_argument("message")
    s.set_defaults(func=cmd_ledger, mutates=True)

    s = sub.add_parser("progress", help="At-a-glance migration metrics (read-only)")
    s.add_argument("--json", action="store_true", help="emit the derived metrics as JSON")
    s.set_defaults(func=cmd_progress)

    s = sub.add_parser(
        "next",
        help="The deterministic next action from current state (resume aid; read-only)",
    )
    s.add_argument("--json", action="store_true", help="emit the next-action directive as JSON")
    s.set_defaults(func=cmd_next)

    return p


def main() -> None:
    args = build_parser().parse_args()
    root = find_root(args.root)
    # Serialize every mutating command's load→mutate→save under an exclusive
    # lock so parallel transformers/verifiers can't lose each other's writes.
    if getattr(args, "mutates", False):
        with manifest_lock(root):
            args.func(root, args)
    else:
        args.func(root, args)


if __name__ == "__main__":
    main()
