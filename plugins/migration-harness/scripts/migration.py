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
    set-status      Set the top-level lifecycle status.
    set-strategy    Set transform description / rollback mode / parallelism.
    add-risk        Append an entry to the risk register.
    set-baseline    Record the baseline (suite command + captured flag).
    add-wave        Add a wave.
    add-unit        Add a unit to a wave.
    set-wave-status Set a wave's status.
    set-unit-status Set a unit's status (optionally attach a report path).
    checkpoint      Snapshot files + record git HEAD before a risky step.
    list-checkpoints List recorded checkpoints.
    rollback        Restore files from a checkpoint snapshot.
    record          Record a verification result for a unit (pass/fail + report).
    ledger          Append a line to the human-readable ledger.

Everything is stdlib-only (json, argparse, subprocess, shutil, pathlib).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
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


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s or "item"


def git(root: Path, *args: str) -> str | None:
    """Run a git command in `root`; return stdout stripped, or None on failure."""
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=str(root),
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
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


def load(root: Path) -> dict:
    p = manifest_path(root)
    if not p.exists():
        die(
            f"No migration found at {p}. Run `migration.py init` first "
            "(from the repo you want to migrate)."
        )
    return json.loads(p.read_text())


def save(root: Path, manifest: dict) -> None:
    manifest["updated"] = now()
    p = manifest_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n")
    tmp.replace(p)


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
    }
    save(root, manifest)
    for sub in ("snapshots", "reports", "baseline"):
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
    risks = m.get("risk_register", [])
    high = sum(1 for r in risks if r.get("severity") == "high")
    print(f"Risks: {len(risks)} ({high} high)   Baseline captured: {m['baseline']['captured']}")
    print(f"Checkpoints: {len(m.get('checkpoints', []))}")
    if not m["waves"]:
        print("Waves: none yet")
        return
    print("Waves:")
    for w in m["waves"]:
        counts: dict[str, int] = {}
        for u in w["units"]:
            counts[u["status"]] = counts.get(u["status"], 0) + 1
        summary = ", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "no units"
        print(f"  - {w['id']} [{w['status']}]  units={len(w['units'])} ({summary})")


def cmd_set_status(root: Path, args) -> None:
    if args.value not in ALL_STATUSES:
        die(f"invalid status '{args.value}'. One of: {', '.join(sorted(ALL_STATUSES))}")
    m = load(root)
    old = m["status"]
    m["status"] = args.value
    save(root, m)
    append_ledger(root, f"Status: {old} → {args.value}")
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
    if args.suite_cmd is not None:
        m["baseline"]["suite_cmd"] = args.suite_cmd
    if args.captured is not None:
        m["baseline"]["captured"] = args.captured == "true"
    if args.characterization:
        m["baseline"]["characterization"].extend(args.characterization.split(","))
    save(root, m)
    print("baseline:", json.dumps(m["baseline"]))


def cmd_add_wave(root: Path, args) -> None:
    m = load(root)
    wid = args.id or f"wave-{len(m['waves']) + 1}"
    if any(w["id"] == wid for w in m["waves"]):
        die(f"wave '{wid}' already exists")
    m["waves"].append(
        {
            "id": wid,
            "title": args.title or "",
            "status": "pending",
            "checkpoint": "",
            "units": [],
        }
    )
    save(root, m)
    append_ledger(root, f"Planned {wid}: {args.title or ''}")
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
    old = wave["status"]
    wave["status"] = args.value
    save(root, m)
    append_ledger(root, f"{args.wave}: {old} → {args.value}")
    print(f"{args.wave}: {old} → {args.value}")


def cmd_set_unit_status(root: Path, args) -> None:
    valid = ("pending", "in-progress", "migrated", "verified", "failed", "rolled-back")
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


def cmd_checkpoint(root: Path, args) -> None:
    m = load(root)
    cid = f"cp-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{slug(args.label)}"
    snap_dir = mig_dir(root) / "snapshots" / cid / "files"
    snap_dir.mkdir(parents=True, exist_ok=True)

    if args.paths:
        files = [p for p in args.paths.split(",") if p]
    else:
        # Snapshot the current working-tree changes (tracked-modified + untracked).
        listing = git(root, "status", "--porcelain")
        files = []
        for line in (listing or "").splitlines():
            # format: XY <path>  (or "XY orig -> new" for renames)
            path = line[3:].strip()
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            if path:
                files.append(path.strip('"'))

    saved = _snapshot_files(root, snap_dir, files)
    head = git(root, "rev-parse", "HEAD")
    dirty = bool(git(root, "status", "--porcelain"))

    if args.commit:
        git(root, "add", "-A")
        git(root, "commit", "-m", f"migration: checkpoint {args.label}", "--no-verify")
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
    }
    (mig_dir(root) / "snapshots" / cid / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    m.setdefault("checkpoints", []).append(meta)
    if args.wave:
        find_wave(m, args.wave)["checkpoint"] = cid
    save(root, m)
    append_ledger(
        root,
        f"Checkpoint `{cid}` ({len(saved)} files snapshotted"
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
    cp = None
    if args.to:
        cp = next((c for c in cps if c["id"] == args.to), None)
        if cp is None:
            die(f"checkpoint '{args.to}' not found")
    else:
        cp = cps[-1]

    snap = mig_dir(root) / "snapshots" / cp["id"] / "files"
    restored = []
    for rel in cp["files"]:
        src = snap / rel
        if src.exists():
            dst = root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            restored.append(rel)

    if args.git_reset and cp.get("git_head"):
        git(root, "reset", "--hard", cp["git_head"])

    if args.wave:
        find_wave(m, args.wave)["status"] = "rolled-back"
    save(root, m)
    append_ledger(
        root,
        f"Rolled back to `{cp['id']}` — restored {len(restored)} files"
        + (" + git reset --hard" if (args.git_reset and cp.get('git_head')) else ""),
    )
    print(f"rolled back to {cp['id']} ({len(restored)} files restored)")


def cmd_record(root: Path, args) -> None:
    if args.result not in ("pass", "fail"):
        die("result must be pass|fail")
    m = load(root)
    wave = find_wave(m, args.wave)
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
    unit = find_unit(wave, args.unit)
    unit["status"] = "verified" if args.result == "pass" else "failed"
    unit["report"] = str(report_file.relative_to(root))
    save(root, m)
    append_ledger(root, f"Verify {args.wave}/{args.unit}: **{args.result}** ({report_file.name})")
    print(f"recorded {args.result} for {args.wave}/{args.unit} → {report_file}")


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
    s.set_defaults(func=cmd_init)

    sub.add_parser("show", help="Print the full manifest").set_defaults(func=cmd_show)
    sub.add_parser("status", help="Print a short status summary").set_defaults(func=cmd_status)

    s = sub.add_parser("set-status", help="Set top-level lifecycle status")
    s.add_argument("value")
    s.set_defaults(func=cmd_set_status)

    s = sub.add_parser("set-strategy", help="Set transform/rollback/parallelism")
    s.add_argument("--transform")
    s.add_argument("--rollback")
    s.add_argument("--parallelism", type=int)
    s.set_defaults(func=cmd_set_strategy)

    s = sub.add_parser("add-risk", help="Append to the risk register")
    s.add_argument("--area", required=True)
    s.add_argument("--risk", required=True)
    s.add_argument("--severity", required=True, help="low|med|high")
    s.add_argument("--mitigation", default="")
    s.add_argument("--id")
    s.set_defaults(func=cmd_add_risk)

    s = sub.add_parser("set-baseline", help="Record baseline suite/flags")
    s.add_argument("--suite-cmd", dest="suite_cmd")
    s.add_argument("--captured", choices=["true", "false"])
    s.add_argument("--characterization", help="comma-separated paths to add")
    s.set_defaults(func=cmd_set_baseline)

    s = sub.add_parser("add-wave", help="Add a wave")
    s.add_argument("--id")
    s.add_argument("--title", default="")
    s.set_defaults(func=cmd_add_wave)

    s = sub.add_parser("add-unit", help="Add a unit to a wave")
    s.add_argument("--wave", required=True)
    s.add_argument("--id")
    s.add_argument("--title", default="")
    s.add_argument("--paths", help="comma-separated file/glob paths")
    s.add_argument("--risk", default="low", help="low|med|high")
    s.add_argument("--depends", help="comma-separated unit ids")
    s.set_defaults(func=cmd_add_unit)

    s = sub.add_parser("set-wave-status", help="Set a wave's status")
    s.add_argument("--wave", required=True)
    s.add_argument("value", help="pending|active|verified|rolled-back")
    s.set_defaults(func=cmd_set_wave_status)

    s = sub.add_parser("set-unit-status", help="Set a unit's status")
    s.add_argument("--wave", required=True)
    s.add_argument("--unit", required=True)
    s.add_argument("value", help="pending|in-progress|migrated|verified|failed|rolled-back")
    s.add_argument("--report")
    s.set_defaults(func=cmd_set_unit_status)

    s = sub.add_parser("checkpoint", help="Snapshot files + record git HEAD")
    s.add_argument("--label", default="checkpoint")
    s.add_argument("--paths", help="comma-separated paths (default: current git changes)")
    s.add_argument("--wave", help="attach this checkpoint to a wave")
    s.add_argument("--commit", action="store_true", help="also git commit current state")
    s.add_argument("--tag", action="store_true", help="tag the commit migration/<id>")
    s.set_defaults(func=cmd_checkpoint)

    sub.add_parser("list-checkpoints", help="List checkpoints").set_defaults(
        func=cmd_list_checkpoints
    )

    s = sub.add_parser("rollback", help="Restore files from a checkpoint snapshot")
    s.add_argument("--to", help="checkpoint id (default: latest)")
    s.add_argument("--wave", help="mark this wave rolled-back")
    s.add_argument("--git-reset", action="store_true", help="also git reset --hard to recorded HEAD")
    s.set_defaults(func=cmd_rollback)

    s = sub.add_parser("record", help="Record a verification result for a unit")
    s.add_argument("--wave", required=True)
    s.add_argument("--unit", required=True)
    s.add_argument("--result", required=True, help="pass|fail")
    s.add_argument("--report", help="path to a report file to store")
    s.add_argument("--note", help="inline note if no report file")
    s.set_defaults(func=cmd_record)

    s = sub.add_parser("ledger", help="Append a line to the ledger")
    s.add_argument("message")
    s.set_defaults(func=cmd_ledger)

    return p


def main() -> None:
    args = build_parser().parse_args()
    root = find_root(args.root)
    args.func(root, args)


if __name__ == "__main__":
    main()
