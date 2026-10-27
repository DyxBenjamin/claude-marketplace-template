---
summary: Blind A/B comparison of two skill versions through the comparator and analyzer agents
tags: [skill-creator, evals, test-skill, subagents]
related: [plugins/base-plugin/agents/comparator.md, plugins/base-plugin/agents/analyzer.md, plugins/base-plugin/skills/test-skill/schemas.md]
---

# Blind comparison

Claude reads this file when the user asks whether one version of a skill is actually better than another. It needs
subagents; without them Claude skips it.

1. Run both versions on the same eval prompts, as test-skill step 1 does, into one iteration directory.
2. Per eval, label the two outputs A and B at random and dispatch the `base-plugin:comparator` agent with
   `output_a_path`, `output_b_path`, `eval_prompt`, the eval's `expectations` (or none), an output path
   `<grading-dir>/comparison-<N>.json`, and the path of `schemas.md`. The brief never says which version is which.
3. Unblind: dispatch the `base-plugin:analyzer` agent in post-hoc mode with `winner`, `winner_skill_path`,
   `winner_transcript_path`, `loser_skill_path`, `loser_transcript_path`, `comparison_result_path`,
   `output_path` (`<grading-dir>/analysis.json`) and the path of `schemas.md`.
4. Report each winner with both overall scores, then the high-priority suggestions for the losing version. Those
   suggestions feed the next revision as `improve.md` describes.
