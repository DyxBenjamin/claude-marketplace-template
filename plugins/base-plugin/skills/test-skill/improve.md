---
summary: Principles for revising a skill from user feedback and run transcripts without overfitting to the evals
tags: [skill-creator, evals, test-skill]
related: [plugins/base-plugin/skills/test-skill/SKILL.md, plugins/base-plugin/skills/test-skill/runs.md]
---

# Improving the skill

Claude reads this file at step 8 of test-skill, after reading the user's feedback.

- Generalize from the feedback. The skill runs many times on many prompts, while Claude and the user iterate on a
  few examples because that is fast. A skill that works only for those examples is useless: instead of fiddly,
  overfitted changes or rigid rules, a stubborn issue calls for a different metaphor or a different pattern of
  working. Trying is cheap, and one may land.
- Keep the prompt lean. Claude reads the run transcripts, not only the final outputs, and removes what is not
  pulling its weight: a part that makes the model waste time on unproductive work goes, and the next iteration
  shows the effect.
- Explain the why. Claude explains the reasoning behind everything the skill asks of the model; current models
  have good theory of mind and go beyond rote instructions given a good harness. Even when the feedback is terse
  or frustrated, Claude works out the task, why the user wrote what they wrote, and what they actually wrote.
  All-caps rules and rigid structures are a yellow flag: Claude reframes them and explains why the thing matters.
- Bundle repeated work. When the transcripts show every run reinventing the same helper (a `create_docx` script,
  a `build_chart` script) or multi-step approach, Claude writes it once in the skill's `scripts/` and tells the
  skill to use it, saving every future invocation the work.
- A glaring flaw the benchmark exposes is fixed even when the user did not mention it.

Claude writes a revision, then rereads it anew from the user's point of view and improves it before rerunning.
