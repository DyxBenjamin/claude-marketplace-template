---
name: new-eval
description: 'Writes claude plugin eval cases for one skill or agent of a plugin (prompt.md plus graders) and, after
  consent, runs one smoke run under a cost ceiling that proves the cases load and score.'
when_to_use: 'Use when "agrega evals", "prueba si la skill se activa", "escribe casos de eval", "mide el plugin",
  "add plugin evals", "does my skill trigger". Complement of new-component: use once a skill or agent exists.'
argument-hint: '<plugin> [skill-or-agent]'
---
# New eval

Objective: `plugins/<plugin>/evals/` holds a should-fire case and a should-not-fire case for the target, and a
smoke run of them exits 0 with no load error.

## Steps
1. Read the target's `SKILL.md` or agent file and the plugin's existing `evals/` (`base-plugin/evals/` is a
   working reference). Each case is `evals/<case>/prompt.md` plus `evals/<case>/graders/<grader>.md`.
2. Write the should-fire case. The `prompt.md` body is a request phrased the way a user types it, with the
   context it needs inline (each run starts in an empty directory), never naming the skill. Frontmatter sets
   `description`, `tags`, `max_turns` (generous: hitting it scores as an error) and `allowed_tools` (include
   `Skill` for a skill). Graders:
   - one on the steps, `type: tool_used`: for a skill `tool: Skill` with
     `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?<name>"'`, for an agent `tool: Agent` with
     `input_match: '"subagent_type"\s*:\s*"<plugin>:<name>"'`;
   - one on the result: `type: regex` for long or exact output, or `type: llm` with a body of concrete PASS and
     FAIL conditions for a short answer.
3. Write the should-not-fire case: a near miss that shares words with the target but needs something else. Its
   `tool_used` grader takes `min: 0`, `max: 0` and `arm: both`, plus one free grader proving the request was
   answered.
4. Ask the user before any run: it calls the model and spends API credit. Smoke run, cheapest form:
   `claude plugin eval plugins/<plugin> --runs 1 --ablation none --threshold 0 --max-cost-usd 0.5 --no-publish
   --trust-plugin --json <scratchpad>/eval.json`. Read `aggregates`, each case's `error`, and the cost from the
   JSON; a load error or a grader that never runs is fixed before anything else.
5. Report to the user what each case and grader checks and what the smoke run cost. Full runs, with the
   no-plugin baseline and its score delta, are the Evals workflow or `claude plugin eval plugins/<plugin>`.

## Output
- Cases on disk. Check: `ls plugins/<plugin>/evals/*/prompt.md plugins/<plugin>/evals/*/graders/*.md`
- Cases load and score (after consent). Check: the smoke command in step 4 exits 0 and the JSON has
  `"partial": false` with no case `error`.
