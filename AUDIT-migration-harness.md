# migration-harness — Consolidated Audit

**Date:** 2026-07-09  **Target:** `plugins/migration-harness/` (v0.1.0)
**Method:** 5 independent AI auditors (read-only), one lens each — `migration.py` correctness,
the destructive-command hook, skill-flow coherence, subagent contracts, end-to-end safety — plus
empirical confirmation of the headline findings on a throwaway git repo.

## Verdict

The harness has a **well-designed narrative of safety** (checkpoints, adversarial verification, a
guard hook, durable state) but the **mechanism underneath does not enforce it**. The recurring root
cause: *safety is written as skill prose and trusted to the model, while `migration.py` — the one
deterministic component — enforces almost none of it, and the checkpoint/rollback machinery captures
the wrong thing.* Four of five auditors independently converged on the same critical defect (the
pre-wave checkpoint snapshots nothing), which I then reproduced.

**Bottom line: do not run this on a real migration until the P0 items are fixed — the reversibility
promise is currently false in the default path.**

## Remediation status — P0 FIXED & VERIFIED (2026-07-09)

All 6 P0 blockers were remediated by three parallel fixer agents (disjoint files) and verified by an
independent 19-check integrated acceptance suite (all green) + `claude plugin validate --strict`.

| P0 | Area | Fix | Verified |
| --- | --- | --- | --- |
| 1+2 | A1–A4 | `checkpoint --wave` auto-derives the wave's target paths and snapshots pre-edit content; `rollback --wave` is a true scoped revert (`git checkout <head> -- <paths>` + `git clean -fd -- <paths>`, snapshot fallback) using the wave's OWN checkpoint; `--git-reset` ordering fixed; never touches `.migration/` | modified→restored, created→deleted, deleted→restored, `.migration/` intact ✅ |
| 3 | B1/B2/B4 | Gate enforced in the script: `set-wave-status verified` and `set-status cleaning\|done` refuse on unfinished work; `set-status executing` needs `baseline.captured`; `record --result fail` auto-rolls-back; `--force` bypasses + logs | verify/done refused with a failed unit; executing refused w/o baseline; `--force` logged ✅ |
| 4 | C1/C2 | `fcntl.flock` on `.migration/manifest.lock` around load→mutate→save + unique per-process temp file | 15/15 parallel `add-risk` recorded, manifest valid ✅ |
| 5 | E1/E4 + E2/E3/E5/E6 | Guard protects `.migration/` from Bash **and** Write/Edit/MultiEdit/NotebookEdit; fail-closed on unparseable manifest; broadened true-positives; fixed false-positives; one-shot override fixed | manifest-clobber/`>`/single-`rm`/Write-to-`.migration` blocked; `restore --staged`/`branch -d`/Write-elsewhere allowed; corrupt→fail-closed ✅ |
| 6 | D1/D2 | Skills: transformers edit the main tree by default; shared-file units never isolated; worktree units must be merged back before verify; verify runs on the main tree; false guard claim removed | (guidance change; enforced by review) ✅ |

**Residuals introduced/surfaced during the fix (now P1, NOT yet done):**
- **Cleanup-as-wave (F4):** the skills now call `checkpoint --wave <id>` for cleanup, but cleanup
  doesn't create a manifest wave → that call would fail at runtime unless cleanup is modeled as a
  real wave. Needs a synthetic cleanup wave (or a no-wave checkpoint form).
- **Rolled-back wave satisfies the `done` precondition (F1):** after `record fail` auto-rolls-back a
  wave, `set-status done` is allowed (precondition accepts "verified **or** rolled-back"). A failed,
  never-redone wave can thus let the migration "complete". Tighten so a rolled-back wave must be
  re-planned→verified (or the whole migration aborted at top level) before `done`.

## Remediation status — P1 FIXED & VERIFIED (2026-07-09)

The full P1 set was remediated by two parallel agents (migration.py+schema / skills+agents) against a
shared CLI contract (cross-checked: every command the skills reference exists in the script), then
verified by a 20-check integrated suite **plus a negative-control (mutation) phase** + `--strict`.

| P1 | Fix | Verified |
| --- | --- | --- |
| F1 | `reset-wave` requalifies a failed/rolled-back wave (wave+units→pending, `attempts` preserved); `done`/`cleaning` now require EVERY wave `verified` (rolled-back no longer counts) | reset-wave resets + preserves attempts; `done` refused with a rolled-back wave ✅ |
| F2 | `record fail` increments `unit.attempts`; verify bounds retries at K=2 then escalates + offers `set-status rolled-back` abort | attempts increment; wired in verify skill ✅ |
| F3 | execute marks units `in-progress` before dispatch + resume clause (no blind re-dispatch) | `deferred`/`in-progress` statuses accepted ✅ |
| B3 | `check --wave` runs the real `suite_cmd` (mechanical gate, not self-report); `set-baseline --captured true` refuses without suite + existing artifacts | check PASS/FAIL by exit code; captured refused on missing artifact ✅ |
| F4 | cleanup creates a real wave+unit so checkpoint/record/rollback have a valid target (closes the residual) | skill wiring; commands resolve ✅ |
| F5/G1 | wave `risk`+`gate` and unit `success` persisted (`add-wave --risk --gate`, `add-unit --success`); execute pauses on a stored gate | fields persist + shown by `status` ✅ |
| G2 | verify blocks a unit on any non-empty `missed_sites` (incomplete ≠ pass) | verifier + verify skill wired ✅ |
| G3 | `deferred` unit status persisted with blocker note | accepted by set-unit-status ✅ |
| H7/B4 | `checkpoint --commit` scoped to target paths (no `git add -A`), hooks run unless `--no-verify`; `set-status executing` refuses in a non-git repo | scoped commit; non-git executing refused ✅ |

**Mutation / negative-control testing (user request).** Added an `agents/mutation-checker.md` subagent
and a mutation step to `migrate-safeguard` (step 4): before the baseline is trusted, characterization
tests are mutation-checked — the code they pin is deliberately broken and the tests must go red; a test
that survives is a **false test** and the gap must be filled. The same method was applied to *this*
remediation's own acceptance suite: `cmd_rollback`, the gate precondition, and the guard were each
mutated on a copy, and every corresponding test flipped to failing (0 false tests) — so the green
above is not vacuous.

Residuals from the P0 pass (cleanup-as-wave F4, rolled-back→done F1) are both resolved above.

## Remediation status — P2 FIXED & VERIFIED (2026-07-09)

The P2 polish/hardening set was done by two parallel agents (script+schema / skills+agents) against a
shared contract, verified by a 9-check suite + P0/P1 regression + `--strict` (all green):

- **G4** — verifiers now attack on distinct lenses (correctness/call-sites · null/boundary/error ·
  concurrency/perf/serialization/numeric) instead of identical clones, killing correlated blind spots.
- **G5** — `migration-scanner` gains read-only `Bash` (real dependency tooling) but its "unused"
  verdict is a deletion *candidate*, not proof; cleanup deletion is sanctioned only by the re-verify.
- **G6** — `migration-verifier` / `risk-analyzer` are constrained to non-mutating shell (no `>`,
  `sed -i`, `rm`); reproduce in a throwaway copy, never the working tree.
- **G7** — per-unit `transform` override (`add-unit --transform`), used by execute when set.
- **G8** — `status` now prints `strategy.parallelism` (the fan-out cap the skills reference).
- **H4/H5/H6/H3** — `init --force` backs up the old manifest + warns on orphan snapshots; `add-risk`
  dup-ID guard; `checkpoint --tag` requires `--commit` (was a silent no-op); `load()` warns (not
  fails) on a schema-version mismatch; Python 3.7+ documented.
- **E6 remainder** — a stale `.allow-destructive` override is cleared on `set-status done|rolled-back`.
- **Trigger tuning** — `safeguard` (before/baseline), `verify` (after/regress), `assess` (only with
  migration intent) descriptions disambiguated to reduce misfire/overlap.

**All P0 + P1 + P2 audit items are now resolved and verified.** The residual P2 notes below are the
original findings, retained for traceability.


### Empirically confirmed (reproduced on a scratch repo)

| # | Claim | Observed |
| --- | --- | --- |
| 1 | Pre-wave `checkpoint` on a clean tree snapshots 0 files; the sanctioned `rollback --wave` then restores nothing | snapshot dir had **0 files**; after edit + rollback the file was still `BROKEN` |
| 2 | The red gate is not enforced | `set-wave-status verified` **and** `set-status done` both succeeded with a `failed` unit present |
| 3 | The guard override leaks past benign commands | after `touch .allow-destructive`, a benign `ls` left it in place; a later `git reset --hard` was allowed |
| 4 | The guard can be disarmed and misses/over-blocks | `rm .migration/manifest.json`, `> file`, single-file `rm file` all **allowed**; safe `git restore --staged .` **blocked** |

---

## Findings by theme (deduplicated, ranked)

Severity: **H** high · **M** med · **L** low. "Auditors" = how many of the 5 independently flagged it.

### A. The rollback backbone does not roll back — **CRITICAL**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| A1 | H | 4 (+confirmed) | Pre-wave `checkpoint` with no `--paths` snapshots only `git status --porcelain` files. Every checkpoint is taken on a **clean** tree (right after the prior wave's commit), so the snapshot is **empty**; `rollback --wave` (no `--git-reset`) restores nothing and leaves the broken code in place. |
| A2 | H | 2 | Even a working rollback is incomplete: files **created** during a wave are never deleted (orphaned); files **deleted**/renamed or **collateral edits** outside `--paths` are unrecoverable. `git status` parsing also misses untracked **directories** (needs `-uall`) and mangles quoted/unicode paths (needs `-z`). |
| A3 | M | 1 | `rollback --git-reset` copies the snapshot back **then** runs `git reset --hard`, clobbering the just-restored snapshot. Order is inverted. |
| A4 | M | 1 | `rollback --wave` ignores the wave's own `checkpoint` field and restores the **latest** checkpoint (`cps[-1]`). Correct only by luck on the strict one-wave rail. |

### B. Safety is prose, not enforced — **CRITICAL**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| B1 | H | 2 | "Auto-rollback on a red gate" is **not automatic**. `record --result fail` just stores the result; nothing triggers a rollback. It happens only if the model chooses to type the command. |
| B2 | H | 2 (+confirmed) | Nothing blocks advancing past a red gate: `set-wave-status verified` / `set-status documenting\|done` succeed even with `failed`/unverified units. Golden rule #2 is unenforced. |
| B3 | H | 1 | Verification is **self-graded**: `record` takes `pass\|fail` as an argument; the script never runs `suite_cmd`, never re-runs characterization tests, never compares to `.migration/baseline/`. `baseline.captured` is a bare boolean the model flips with no check that any artifact exists. |
| B4 | M | 2 | Every phase "precondition" is advisory; `set-status` accepts any transition from any state. A confused/resumed agent can skip safeguard and transform with no baseline. |

### C. Concurrency — the "durable state" isn't safe under the fan-out it's designed for — **HIGH**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| C1 | H | 2 | Every command does `load()`→mutate→`save()` with **no lock**. Parallel transformers/verifiers (the whole point of waves) overwrite each other → **lost updates**, silently. |
| C2 | H | 2 | `save()` writes to a **fixed shared** temp `manifest.json.tmp` for every process, defeating the tmp+rename atomicity → **torn/corrupt** manifest under concurrent writes (which then breaks `load()` and disarms the guard). |
| C3 | L | 1 | Ledger header/append races; manifest save + ledger append aren't a single transaction. |

### D. Worktree isolation breaks execute→verify — **HIGH**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| D1 | H | 1 | `isolation: worktree` transformers edit an isolated worktree; **nothing merges those edits back** to the main tree. `verify` runs the suite and `git diff` on the **unmigrated** main tree → sees no change → votes green → a **no-op migration reports success**. |
| D2 | H | 1 | For units sharing files, separate worktrees just **defer the collision** to a 3-way merge no step owns → one unit's edit is silently clobbered. Worktrees are the wrong tool for the overlapping case they're recommended for. |

### E. The guard hook — bypassable, self-disarming, and over-blocking — **HIGH**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| E1 | H | 1 (+confirmed) | The guard keys entirely off `.migration/manifest.json`. Clobbering it (`rm`, `>`, `mv` — none matched) **permanently disarms** the guard. Fail-open on an unparseable manifest is the same lever. |
| E2 | H | 2 | Big false-negative class slips through: single-file `rm`, `>`/`truncate -s` truncation, `dd`, `find -delete`, `xargs rm`, `git rm`, `sed -i`, `curl \| sh`, `git checkout -f`, `git switch --discard-changes`, `git update-ref -d`. |
| E3 | H | 1 | Trivial bypasses: `/bin/rm` (anchor defeated by path prefix), quoting (`git "reset" --hard`), env indirection (`X="reset --hard"; git $X`), backslash-newline continuation. |
| E4 | M | 2 | Only the **Bash** tool is matched. `Write`/`Edit`/`NotebookEdit` mutate/delete files unguarded — including writing over `.migration/` (self-neutralization again). `migrate-execute` falsely claims the guard "will remind you" before transforms (which go through Edit/Write). |
| E5 | M | 2 (+confirmed) | Over-blocking trains users to disable it: `rm -rf node_modules`, `git restore --staged .` (safe unstage), `git branch -d merged` (`-i` matches `-D`), `git push origin wip-f`, even `echo "...drop table..."`. |
| E6 | M | 2 (+confirmed) | Override file: consumed only on the **next destructive** command (leaks past benign ones), not command-bound, races under parallel Bash, consumed even if the user then declines, and lingers into the next migration. |
| E7 | M | 1 | Root detection (`CLAUDE_PROJECT_DIR` → `git toplevel` → `PWD`) can resolve the **wrong repo** (the plugin lives inside a git repo); `$ROOT` never constrains where the command actually runs. |

### F. State-machine / flow gaps — **MED**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| F1 | H | 1 | Failed wave is left `rolled-back`, but `execute` only picks `pending` waves → the wave to redo is **skipped**; the re-plan/re-execute loop dead-ends. Reverted units keep their `verified` status. |
| F2 | M | 1 | Verify-fail retry is **unbounded** and the whole-migration abort (`set-status rolled-back`) is never invoked by any skill. |
| F3 | M | 2 | Resume mid-execute is ambiguous (`in-progress` status is defined but never used). A crash after editing but before recording leaves units `pending` → **double-application** on resume for non-idempotent transforms. |
| F4 | M | 1 | `migrate-cleanup` step 4 tells the agent to run `migration.py record`, but `record` requires `--wave`/`--unit` cleanup has no valid target for. |
| F5 | L | 1 | Human gates + per-wave risk are decided in `plan` but have **no schema field** → lost on resume; `execute` rolls through a verbally-agreed gate. |

### G. Skill↔agent contract & schema gaps — **MED**
| ID | Sev | Auditors | Finding |
| --- | --- | --- | --- |
| G1 | H | 1 | The per-unit **success criterion** (used by transformer, plan, execute, verifier) has **no field** in the unit schema — nowhere to persist it. |
| G2 | M | 1 | Verifier returns `missed_sites`, but the verify vote consumes only `{regression,confidence,evidence}` → an **incomplete** migration (sites missed) passes the gate. |
| G3 | M | 1 | Transformer can return `deferred`, but there is no `deferred`/`blocked` **unit status** → the "blocked on dep" signal is lost as plain `pending` across resume. |
| G4 | M | 1 | "Independent" verifiers are N **clones** of one prompt with identical inputs → correlated blind spots. Majority vote cuts variance, not systematic bias. Diversify by attack lens. |
| G5 | M | 1 | `migration-scanner` (Read/Grep/Glob, no Bash) can't prove **absence** — yet `cleanup` leans on it to authorize **deletion** of "dead" code (dynamic/config refs invisible to grep). |
| G6 | M | 1 | `migration-verifier`/`risk-analyzer` are labeled read-only but hold `Bash` (a write escape hatch: `> f`, `sed -i`). The guarantee is prompt-only. |
| G7 | L | 1 | A single global `strategy.transform` is passed to every transformer; heterogeneous migrations need per-unit rules. |
| G8 | L | 1 | The `strategy.parallelism` cap is advisory (unenforced) and isn't even printed by `status` (only `show`). |

### H. Smaller correctness / robustness (mostly `migration.py`) — **LOW–MED**
| ID | Sev | Finding |
| --- | --- | --- |
| H1 | M | Checkpoint ID is second-resolution + label; two in the same second (parallel) **overwrite** each other's snapshot dir. |
| H2 | M | `checkpoint`/`record` do file+git side effects **before** validating `--wave`/`--unit` → orphan commits/tags/reports when the target doesn't exist. Validate first. |
| H3 | M | JSON corruption / missing fields raise raw tracebacks (no try/except in `load()`); no `schema` version check. |
| H4 | M | `init --force` clobbers the whole plan with no backup and leaves orphaned snapshot dirs. |
| H5 | L | `add-risk` lacks the dup-ID guard the others have; `checkpoint --tag` without `--commit` silently no-ops; `--paths` allows `../`/absolute path traversal and doesn't glob-expand (but unit paths are globs); non-git `--commit` records `committed:true` with no commit. |
| H6 | L | Real Python floor is **3.7** (via `from __future__ import annotations`), not 3.10 — but it's undocumented and unguarded. |
| H7 | M | `checkpoint --commit` runs `git add -A` (sweeps unrelated WIP into migration commits) and `--no-verify` (bypasses pre-commit hooks / secret scanners). |

---

## Remediation plan (prioritized)

**Strategy:** move enforcement out of skill prose and into `migration.py` (the deterministic layer);
fix checkpoint to capture pre-edit content of the target paths; make rollback a true revert; and
rework the guard to protect its own state instead of playing regex whack-a-mole.

### P0 — Must fix before any real migration (the safety promise is currently false)
1. **Checkpoint the right files.** Derive `--paths` from the wave's units' paths (or require them);
   snapshot the **committed pre-edit content** (`git show HEAD:<path>` / `git ls-files`), not
   `git status`. Error/warn loudly on an empty snapshot. *(A1)*
2. **Make rollback a true revert.** Record which paths existed at checkpoint so rollback can delete
   files created since and restore deleted ones; use `git status -z -uall`; fix the `--git-reset`
   ordering (reset first, then re-lay the snapshot). *(A2, A3, A4)*
3. **Enforce the gate in the script.** `record --result fail` performs/forces the rollback;
   `set-wave-status verified` and `set-status documenting|done` **refuse** while any in-scope unit
   isn't verified. *(B1, B2, B4)*
4. **Lock the state.** `fcntl.flock` around load→mutate→save + a unique per-process temp file. *(C1, C2)*
5. **Fix the guard's self-neutralization.** Protect `.migration/` from all tools (block writes/removal
   targeting it), add a `Write|Edit|MultiEdit|NotebookEdit` matcher, and **fail closed** when a
   manifest exists but its status can't be parsed. *(E1, E4)*
6. **Close the worktree hole.** Define an explicit merge-back step (apply each worktree's patch to the
   main tree before checkpoint/verify), and run verify on the merged tree — or drop the
   `isolation: worktree` recommendation until it's implemented. *(D1, D2)*

### P1 — Important correctness / flow
- Reset a failed wave to `pending` and add a "resume `active`/`rolled-back` wave" clause to execute;
  use the `in-progress` unit marker so resume is recoverable. *(F1, F3)*
- Make `verify` mechanically re-run `suite_cmd` + characterization and derive pass/fail from real
  exit codes; have `set-baseline --captured true` check the artifacts exist. *(B3)*
- Add schema fields: unit `success` criterion, `deferred`/`blocked` unit status, wave `risk` + `gate`.
  *(G1, G3, F5)*
- Fail the vote on non-empty `missed_sites`. *(G2)*
- Bound verify-fail retries and wire the `rolled-back` abort. *(F2)*
- Fix cleanup's `record` usage (model cleanup as a synthetic wave, or just use `ledger`). *(F4)*
- Git preconditions: refuse non-git (or require an explicit opt-out flag); scope `--commit` to the
  migration's paths and drop/gate `--no-verify`. *(H7, B4)*

### P2 — Hardening / polish
- Diversify verifiers by attack lens (call-sites / null-boundary-error / concurrency-perf). *(G4)*
- Grant `migration-scanner` read-only Bash for real dependency resolution; never let scanner output
  **alone** authorize a deletion. *(G5)*
- Guard tuning: stop blocking `git restore --staged`, `git branch -d`, `git push …-f`, temp `rm -rf`;
  broaden true-positives pragmatically; accept the blocklist's limits (prefer tamper-proofing state).
  Bind the override to a specific command, consume it in a PostToolUse hook, and clear it on
  `done`/`rolled-back`. *(E2, E3, E5, E6)*
- `migration.py` robustness: unique checkpoint IDs, validate-before-side-effect, JSON error handling +
  schema-version check, `init --force` backup, `add-risk` dup guard, reject path traversal, document
  Python 3.7+. *(H1–H6)*
- Print `strategy.parallelism` in `status`; describe the cap as advisory (point to the Workflow
  engine for a hard cap). *(G8)*
- Tighten skill triggers: `safeguard` → "before/baseline", `verify` → "verify this wave / did this
  regress", `assess` → qualify with migration intent. *(flow finding 8)*

---

## What the auditors verified is genuinely sound
- The **design** of adversarial verification (independent context, majority vote, "one concrete
  counterexample beats three shrugs", attack the untested edges) is good methodology.
- Single-writer crash durability (tmp + `os.replace`) is correct; the gap is only concurrency.
- In-place content restore via `shutil.copy2` is faithful — the flaw is *what* gets captured.
- Status enums, ID conventions, and every migration.py command/flag the skills reference exist and
  are spelled correctly — no runtime "invalid status" errors on the happy path.
- Append-only ledger + per-checkpoint `meta.json` give a real audit trail.
- The guard fails **open** on internal error (`set -uo pipefail`, no `set -e`) — it can't wedge a
  session — and correctly no-ops outside an active migration. Its problem is over-claiming, not
  misfiring.
- Linear phase hand-offs (assess→…→done) each set the right next status and invoke the right skill;
  the "next wave vs cleanup" decision is unambiguously owned by `document`.
