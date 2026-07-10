# Artifacts — audit evidence & method record

This folder is **evidence, not runtime**. Nothing here is loaded by the plugin
(the harness auto-discovers `skills/`, `agents/`, `hooks/`, `scripts/`, … — not
`artifacts/`). It exists to document *how* this plugin is built and hardened, so
the process is auditable and reusable.

The method, in short: an agentic system is only as trustworthy as the adversarial
pressure it survives. So each major change is put through a **multi-agent
adversarial audit** before it's trusted —

1. **Fan out** independent reviewers, one per lens (state-machine correctness,
   the safety hook, cross-file consistency, vague instructions, multi-agent
   weaknesses, missing standards, plugin-spec conformance, one-shot blockers).
2. **Deduplicate** across lenses.
3. **Verify adversarially** — one skeptic per finding, told to *refute* it and
   reproduce it on a scratch repo; anything it can't reproduce is dropped, and
   re-discoveries of prior audits are folded in, not double-counted.
4. **Remediate** the survivors deterministically (move enforcement into
   `scripts/migration.py`, the one non-LLM component), then **re-verify**,
   including negative-control (mutation) testing so a green result isn't vacuous.

That loop is why the harness moved from "safety written as skill prose and
trusted to the model" toward "safety enforced by the deterministic layer."

## The record

| File | What it is |
| --- | --- |
| [`AUDIT-migration-harness.md`](AUDIT-migration-harness.md) | **Audit 1** — the first consolidated security/quality audit (5 auditors) that found the reversibility promise was false in the default path, plus the tracked P0/P1/P2 remediation that fixed it. |
| [`AUDIT-2-oneshot-readiness.md`](AUDIT-2-oneshot-readiness.md) | **Audit 2** — a 75-agent post-remediation audit (8 finders → per-finding adversarial verification → 3-lens improvement panel): 47 confirmed findings and the one-shot roadmap. It motivated the worktree-per-wave execution backbone. |

Read them newest-last: audit 1 establishes the baseline and its fixes; audit 2
audits *those* fixes and charts what's next. Findings marked confirmed were each
independently reproduced from the then-current files by a verifier trying to
prove them wrong.
