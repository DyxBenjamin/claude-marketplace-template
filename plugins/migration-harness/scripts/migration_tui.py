#!/usr/bin/env python3
"""migration_tui.py — a live terminal dashboard for a migration-harness run.

Reads the SAME durable state the harness writes (`.migration/manifest.json` +
ledger) and renders it, so a human can watch a long migration and — critically —
a fresh session that inherited a half-finished run can see exactly where it is and
what to do next. Everything shown is derived by `migration.py` (compute_progress /
compute_next), so the dashboard and the orchestrator agree.

Modes:
  (default, TTY) live curses dashboard that re-renders whenever the manifest
                 changes; keys: q quit · r refresh · j/k or ↑/↓ scroll ledger.
  --once         print one plain-text snapshot and exit (also the automatic
                 behaviour when stdout is not a TTY, e.g. piped to a file/agent).
  --json         emit the whole snapshot as JSON (for the AI / scripting).

Stdlib only (curses is imported lazily so --once/--json work without a TTY).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Reuse the harness's own state layer as the single source of truth.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import migration as M  # noqa: E402


# --------------------------------------------------------------------------- #
# Presentation vocabulary (shared by the plain and curses renderers)
# --------------------------------------------------------------------------- #
STATUS_GLYPH = {
    "verified": "✓", "integrated": "✓", "done": "✓",
    "active": "▶", "in-progress": "▶", "executing": "▶", "verifying": "▶",
    "migrated": "•", "pending": "·", "assessing": "·", "planning": "·",
    "safeguarding": "·", "documenting": "·", "cleaning": "·",
    "failed": "✗", "rolled-back": "⤺", "rollback-failed": "✗", "deferred": "⊘",
}
ANSI = {
    "green": "\033[32m", "yellow": "\033[33m", "red": "\033[31m",
    "magenta": "\033[35m", "cyan": "\033[36m", "dim": "\033[2m",
    "bold": "\033[1m", "reset": "\033[0m",
}
SEV_COLOR = {"info": "cyan", "warn": "yellow", "critical": "red"}


def status_color(s: str) -> str:
    if s in ("verified", "integrated", "done"):
        return "green"
    if s in ("active", "in-progress", "executing", "verifying", "migrated"):
        return "yellow"
    if s in ("failed", "rolled-back", "rollback-failed"):
        return "red"
    if s == "deferred":
        return "magenta"
    return "dim"


def glyph(s: str) -> str:
    return STATUS_GLYPH.get(s, "·")


# --------------------------------------------------------------------------- #
# Snapshot — one structured view built from the manifest (reused by all modes)
# --------------------------------------------------------------------------- #
def build_snapshot(root: Path) -> dict:
    m = M.read_manifest(root)
    if m is None:
        return {"ok": False, "root": str(root), "manifest_path": str(M.manifest_path(root))}
    waves = []
    for w in m.get("waves", []):
        waves.append(
            {
                "id": w["id"], "title": w.get("title", ""), "status": w.get("status", ""),
                "risk": w.get("risk", "low"), "gate": bool(w.get("gate")),
                "worktree": w.get("worktree", ""), "branch": w.get("branch", ""),
                "integrated": w.get("integrated", ""),
                "units": [
                    {
                        "id": u["id"], "status": u.get("status", ""), "title": u.get("title", ""),
                        "attempts": int(u.get("attempts", 0) or 0),
                        "paths": u.get("paths", []), "success": u.get("success", ""),
                    }
                    for u in w.get("units", [])
                ],
            }
        )
    try:
        mtime = M.manifest_path(root).stat().st_mtime
    except OSError:
        mtime = 0
    return {
        "ok": True, "root": str(root), "manifest_path": str(M.manifest_path(root)),
        "progress": M.compute_progress(m), "next": M.compute_next(m),
        "waves": waves, "ledger": M.recent_ledger(root, 60), "mtime": mtime,
    }


def unit_line(u: dict) -> str:
    extra = f"  ×{u['attempts']}" if u["attempts"] else ""
    paths = ", ".join(u["paths"][:2]) + (" …" if len(u["paths"]) > 2 else "")
    return f"{glyph(u['status'])} {u['id']} [{u['status']}]{extra}  {paths}"


def wave_headline(w: dict) -> str:
    gate = " ⃟gate" if w["gate"] else ""
    marks = []
    if w["worktree"]:
        marks.append(f"wt:{w['worktree']}")
    if w["integrated"]:
        marks.append(f"merged:{str(w['integrated'])[:8]}")
    tail = ("  " + "  ".join(marks)) if marks else ""
    title = f" — {w['title']}" if w["title"] else ""
    return f"{glyph(w['status'])} {w['id']} [{w['status']}] risk={w['risk']}{gate}{title}{tail}"


# --------------------------------------------------------------------------- #
# Plain renderer (for --once / non-TTY); ANSI colour only when writing to a TTY
# --------------------------------------------------------------------------- #
def render_plain(snap: dict, color: bool) -> list[str]:
    def c(text, name):
        if not color or name not in ANSI:
            return text
        return f"{ANSI[name]}{text}{ANSI['reset']}"

    if not snap["ok"]:
        return [
            c("No migration found.", "yellow"),
            f"  looked in: {snap['manifest_path']}",
            "  Start one with:  /migration-harness:migrate",
        ]

    p = snap["progress"]
    nx = snap["next"]
    L: list[str] = []
    L.append(c(f"{p['name']}", "bold") + c(f"   [{p['status']}]", status_color(p["status"])) +
             f"   {p['execution']} → {p['branch'] or '(no branch)'}")
    if p["goal"]:
        L.append(c(f"  {p['goal']}", "dim"))

    # Phase strip
    strip = []
    for i, ph in enumerate(p["phases"]):
        strip.append(c(f"[{ph}]", "cyan") if i == p["phase_index"] else c(ph, "dim"))
    L.append("  " + "  ".join(strip))
    L.append("")

    # Next action — the resume answer, made prominent
    L.append(c("▶ NEXT", SEV_COLOR.get(nx["severity"], "cyan")) + "  " +
             c(nx["action"], "bold") + f" — {nx['reason']}")
    if nx.get("hint"):
        L.append(c(f"    hint: {nx['hint']}", "dim"))
    for cmd in nx.get("commands", []):
        L.append("    " + c("$ " + cmd, "green"))
    L.append("")

    # Waves + units
    w = p["waves"]
    header = (f"Waves  {w['verified']}/{w['total']} verified · {w['integrated']} integrated · "
              f"{w['active']} active · {w['pending']} pending · {w['rolled-back']} rolled-back")
    if w["rollback-failed"]:
        header += c(f" · {w['rollback-failed']} ROLLBACK-FAILED", "red")
    L.append(c(header, "bold"))
    for wv in snap["waves"]:
        L.append("  " + c(wave_headline(wv), status_color(wv["status"])))
        for u in wv["units"]:
            L.append("      " + c(unit_line(u), status_color(u["status"])))
    L.append("")

    # State summary
    u = p["units"]
    by = ", ".join(f"{k}:{v}" for k, v in sorted(u["by_status"].items())) or "none"
    L.append(c(f"Units {u['total']} ({by}) · attempts {p['attempts_total']} · "
               f"baseline {'✓' if p['baseline_captured'] else '✗'} · "
               f"standards {','.join(p['standards']) or 'none'} · "
               f"checkpoints {p['checkpoints']} · risks {p['risks']['total']}({p['risks']['high']} high)", "dim"))
    L.append("")

    # Ledger tail
    L.append(c("Ledger (recent)", "bold"))
    for ln in snap["ledger"][-12:]:
        L.append("  " + c(ln, "dim"))
    return L


# --------------------------------------------------------------------------- #
# Curses renderer (live dashboard)
# --------------------------------------------------------------------------- #
def run_tui(root: Path, interval: float) -> None:
    import curses

    def _main(stdscr):
        curses.curs_set(0)
        stdscr.nodelay(True)
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        names = {"green": curses.COLOR_GREEN, "yellow": curses.COLOR_YELLOW,
                 "red": curses.COLOR_RED, "magenta": curses.COLOR_MAGENTA,
                 "cyan": curses.COLOR_CYAN}
        cattr = {}
        for i, (nm, col) in enumerate(names.items(), start=1):
            try:
                curses.init_pair(i, col, bg)
                cattr[nm] = curses.color_pair(i)
            except curses.error:
                cattr[nm] = 0
        cattr["dim"] = curses.A_DIM
        cattr["bold"] = curses.A_BOLD

        def attr(name):
            return cattr.get(name, 0)

        def put(y, x, text, name=None, extra=0):
            h, wid = stdscr.getmaxyx()
            if y < 0 or y >= h or x >= wid:
                return
            text = text[: max(0, wid - x - 1)]
            try:
                stdscr.addstr(y, x, text, (attr(name) if name else 0) | extra)
            except curses.error:
                pass

        ledger_scroll = 0
        last_mtime = None
        snap = build_snapshot(root)

        while True:
            # Re-read only when the manifest actually changed.
            try:
                mp = M.manifest_path(root)
                mt = mp.stat().st_mtime if mp.exists() else 0
            except OSError:
                mt = 0
            if mt != last_mtime:
                snap = build_snapshot(root)
                last_mtime = mt

            stdscr.erase()
            h, wid = stdscr.getmaxyx()
            y = 0

            if not snap["ok"]:
                put(0, 0, "No migration found.", "yellow", curses.A_BOLD)
                put(1, 2, f"looked in: {snap['manifest_path']}", "dim")
                put(2, 2, "Start one with:  /migration-harness:migrate")
            else:
                p, nx = snap["progress"], snap["next"]
                put(y, 0, f"{p['name']}", "bold", curses.A_BOLD)
                put(y, len(p["name"]) + 2, f"[{p['status']}]", status_color(p["status"]))
                put(y, len(p["name"]) + len(p["status"]) + 6,
                    f"{p['execution']} → {p['branch'] or '(no branch)'}", "dim")
                y += 1
                # Phase strip
                x = 0
                for i, ph in enumerate(p["phases"]):
                    cur = i == p["phase_index"]
                    put(y, x, ph, "cyan" if cur else "dim", curses.A_BOLD if cur else 0)
                    x += len(ph) + 2
                y += 2

                # NEXT box
                sev = SEV_COLOR.get(nx["severity"], "cyan")
                put(y, 0, "▶ NEXT ", sev, curses.A_BOLD)
                put(y, 7, f"{nx['action']} — {nx['reason']}", None, curses.A_BOLD)
                y += 1
                if nx.get("hint"):
                    put(y, 4, f"hint: {nx['hint']}", "dim")
                    y += 1
                for cmd in nx.get("commands", []):
                    put(y, 4, "$ " + cmd, "green")
                    y += 1
                y += 1

                # Waves
                w = p["waves"]
                hdr = (f"Waves  {w['verified']}/{w['total']} verified · {w['integrated']} integrated · "
                       f"{w['active']} active · {w['pending']} pending · {w['rolled-back']} rolled-back")
                put(y, 0, hdr, "bold", curses.A_BOLD)
                if w["rollback-failed"]:
                    put(y, len(hdr) + 1, f"· {w['rollback-failed']} ROLLBACK-FAILED", "red", curses.A_BOLD)
                y += 1
                waves_bottom = h - 10  # leave room for ledger + footer
                for wv in snap["waves"]:
                    if y >= waves_bottom:
                        put(y, 2, "… (terminal too short to show all waves)", "dim")
                        y += 1
                        break
                    put(y, 2, wave_headline(wv), status_color(wv["status"]))
                    y += 1
                    for u in wv["units"]:
                        if y >= waves_bottom:
                            break
                        put(y, 6, unit_line(u), status_color(u["status"]))
                        y += 1
                y += 1

                # Ledger (scrollable), fills the rest above the footer
                put(y, 0, "Ledger (recent)   ↑/↓ scroll", "bold", curses.A_BOLD)
                y += 1
                ledger = snap["ledger"]
                avail = max(1, h - y - 1)
                max_scroll = max(0, len(ledger) - avail)
                ledger_scroll = min(ledger_scroll, max_scroll)
                window = ledger[max(0, len(ledger) - avail - ledger_scroll):
                                len(ledger) - ledger_scroll] if ledger_scroll else ledger[-avail:]
                for ln in window:
                    put(y, 2, ln, "dim")
                    y += 1

            # Footer
            up = snap.get("progress", {}).get("updated", "") if snap["ok"] else ""
            put(h - 1, 0,
                f" q quit · r refresh · j/k scroll · watching {os.path.relpath(snap['manifest_path'], str(root))}"
                + (f" · updated {up}" if up else ""),
                None, curses.A_REVERSE)

            stdscr.refresh()

            ch = stdscr.getch()
            if ch in (ord("q"), 27):
                break
            elif ch == ord("r"):
                last_mtime = None
            elif ch in (ord("j"), curses.KEY_DOWN):
                ledger_scroll = max(0, ledger_scroll - 1)
            elif ch in (ord("k"), curses.KEY_UP):
                ledger_scroll += 1
            elif ch == ord("g"):
                ledger_scroll = 10 ** 6
            elif ch == ord("G"):
                ledger_scroll = 0
            time.sleep(min(0.15, max(0.02, interval / 10)))

    try:
        curses.wrapper(_main)
    except KeyboardInterrupt:
        pass


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(
        prog="migration_tui.py",
        description="Live terminal dashboard for a migration-harness run.",
    )
    ap.add_argument("--root", help="repo root (defaults to git toplevel / CLAUDE_PROJECT_DIR / cwd)")
    ap.add_argument("--json", action="store_true", help="print the full snapshot as JSON and exit")
    ap.add_argument("--once", action="store_true", help="print one plain-text snapshot and exit")
    ap.add_argument("--interval", type=float, default=1.0, help="live refresh cadence seconds (default 1)")
    args = ap.parse_args()

    root = M.find_root(args.root)
    snap = build_snapshot(root)

    if args.json:
        print(json.dumps(snap, indent=2, default=str))
        return
    # Non-interactive when asked, or when there's no TTY (piped / captured by an agent).
    if args.once or not sys.stdout.isatty():
        print("\n".join(render_plain(snap, color=sys.stdout.isatty())))
        return
    run_tui(root, args.interval)


if __name__ == "__main__":
    main()
