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
    rollback        True, scoped revert of a wave to its checkpoint.
    check           Run baseline.suite_cmd for a wave; write a suite report.
    record          Record a verification result for a unit (pass/fail + report).
    ledger          Append a line to the human-readable ledger.

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

SCHEMA_VERSION = 1
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


def find_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("MIGRATION_ROOT")
    if env:
        return Path(env).resolve()
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
    if head is None:
        print(
            "warning: no git repo detected. Rollback is far safer with git — "
            "consider `git init` before migrating.",
            file=sys.stderr,
        )
    manifest = {
        "schema": SCHEMA_VERSION,
        "name": args.name,
        "goal": args.goal or "",
        "status": "assessing",
        "created": now(),
        "updated": now(),
        "strategy": {
            "transform": args.transform or "",
            "rollback": "git+snapshots",
            "parallelism": args.parallelism,
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
    for sub in ("snapshots", "reports", "baseline", "standards"):
        (mig_dir(root) / sub).mkdir(parents=True, exist_ok=True)
    append_ledger(root, f"Initialized migration **{args.name}**. Goal: {args.goal or '(unset)'}")
    print(f"Initialized migration '{args.name}' at {mig_dir(root)}")


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
        # Every wave must be verified. A rolled-back wave no longer counts (F1):
        # it must be reset (`reset-wave`) and re-done, or the whole migration
        # aborted via top-level `set-status rolled-back`, before completing.
        bad = [w["id"] for w in waves if w["status"] != "verified"]
        if bad:
            return f"wave(s) not verified: {', '.join(bad)}"
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
    valid = ("pending", "active", "verified", "rolled-back")
    if args.value not in valid:
        die(f"wave status must be one of {valid}")
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
    unit["status"] = args.value
    if args.report:
        unit["report"] = args.report
    save(root, m)
    print(f"{args.wave}/{args.unit}: {old} → {args.value}")


def cmd_reset_wave(root: Path, args) -> None:
    """Reset a failed/rolled-back wave for re-planning (F1): the wave and ALL of
    its units go back to `pending` so `execute` (which picks `pending` waves)
    will re-run it. `attempts` counters are deliberately preserved so the retry
    bound survives the reset."""
    m = load(root)
    wave = find_wave(m, args.wave)
    old = wave["status"]
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
        restored, removed = _snapshot_restore(root, cp)
        if git_available:
            _git_clean_scoped(root, pathspecs)
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


def cmd_rollback(root: Path, args) -> None:
    m = load(root)
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
    find_wave(m, args.wave)  # validate the wave exists before writing a report
    suite = (m.get("baseline", {}) or {}).get("suite_cmd", "") or ""
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
        suite, shell=True, cwd=str(root), capture_output=True, text=True
    )
    passed = proc.returncode == 0
    verdict = "PASS" if passed else "FAIL"
    report_file.write_text(
        f"# Suite check — {args.wave}\n\n"
        f"- Command: `{suite}`\n"
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

    s = sub.add_parser("set-strategy", help="Set transform/rollback/parallelism")
    s.add_argument("--transform")
    s.add_argument("--rollback")
    s.add_argument("--parallelism", type=int)
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
