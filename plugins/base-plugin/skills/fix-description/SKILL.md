---
name: fix-description
description: 'Rewrites a finished skill''s description from a user-reviewed set of trigger queries, choosing the
  candidate with the best held-out trigger score, and reports the before and after scores.'
when_to_use: 'Use when "optimize the description", "the skill does not trigger", "improve triggering", "fires on
  the wrong requests", "la skill no se activa", "optimiza la descripcion". Complement of test-skill: use once the
  skill works. Step 3 of new-skill.'
argument-hint: '<skill-dir>'
---
# Fix description

> Modified from anthropics/skills skill-creator (Apache-2.0); original terms in `LICENSE.txt`.

Objective: the skill's frontmatter `description` is the `best_description` of `run_loop.ts`, selected by test
score, and the user saw the before and after with the scores.

Claude runs the Steps as `delegate.md` says.

The `description` is the main mechanism that decides whether Claude invokes a skill. Claude runs this skill once
the skill is finished and the user agrees it is in good shape. It needs the `claude` CLI (`claude -p`), so it runs
in Claude Code and Cowork; on Claude.ai Claude skips it. `<workspace>` is the project's
`.claude/base-plugin/<skill-name>-workspace/`.

## Steps
1. Write 20 trigger queries (8-10 should-trigger, 8-10 should-not-trigger) as `queries.md` describes.
2. Fill `${CLAUDE_PLUGIN_ROOT}/assets/eval_review.html`: `__EVAL_DATA_PLACEHOLDER__` becomes the JSON array of
   queries (unquoted: it is a JS variable assignment), `__SKILL_NAME_PLACEHOLDER__` the skill's name,
   `__SKILL_DESCRIPTION_PLACEHOLDER__` its current description. Write it to `<workspace>/eval_review.html` and
   open it (`open <workspace>/eval_review.html`).
3. The user edits queries, toggles should-trigger, adds or removes entries, and clicks "Export Eval Set". Claude
   takes the newest `~/Downloads/eval_set*.json` (there may be `eval_set (1).json`) and saves it to
   `<workspace>/trigger-eval.json`. Bad queries make bad descriptions, so this review is not skipped.
4. Tell the user the loop takes a while, then run it in the background:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/run_loop.ts" --eval-set <workspace>/trigger-eval.json --skill-path
   <skill-dir> --model <model-id> --max-iterations 5 --verbose`. `--model` is the model ID powering this session,
   from Claude's own system prompt, so the test matches what the user experiences.
5. Tail its output now and then and tell the user the iteration and the scores.
6. Take `best_description` from the JSON it returns, write it into the skill's frontmatter, and show the user the
   before and after with the scores.

`run_loop.ts` splits the set 60% train and 40% held-out test, evaluates the current description (each query 3
times, for a reliable trigger rate), and has `improve_description.ts` call Claude to propose a better one from
what failed. It re-evaluates each candidate on train and test, up to 5 iterations, opens an HTML report of every
iteration in the browser, and selects `best_description` by test score, not train score, to avoid overfitting.

## Output
- Description applied. Check: `grep -F "<best_description start>" <skill-dir>/SKILL.md`
- Still within the skill rules. Check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check_skill.ts" <skill-dir>`
