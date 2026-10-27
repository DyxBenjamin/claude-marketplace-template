---
name: new-skill
description: 'Takes a skill from idea to a tested, well-triggering, packaged skill by chaining write-skill,
  test-skill, fix-description and ship-skill.'
when_to_use: 'Use when "create a skill", "make a new skill", "build a skill for", "turn this workflow into a
  skill", "crea una skill", "hazme una skill". Complement of write-skill: use for the whole path from idea to
  package; a single stage goes to its own skill. Steps: write-skill, test-skill, fix-description, ship-skill.'
argument-hint: '<what the skill should do>'
---
# New skill

> Modified from anthropics/skills skill-creator (Apache-2.0); original terms in `LICENSE.txt`.

Objective: the skill passes `check_skill.ts`, the user is satisfied with its tested behavior, its description is
optimized, and it is packaged when packaging applies.

Claude runs the Steps as `delegate.md` says.

Claude works out where the user is and starts from there: a user with a draft goes straight to step 2; a user
who wants no evaluations, just collaboration, gets steps 1 and 3 only. Each stage that ends hands its result to
the next.

## Steps
1. `/base-plugin:write-skill` with the user's request.
2. `/base-plugin:test-skill` on the skill folder; repeat it until the user is satisfied, then offer to expand the
   test set and run it again at larger scale.
3. `/base-plugin:fix-description` on the skill folder, offered once the skill works.
4. `/base-plugin:ship-skill` on the skill folder, when `present_files` is available or the user wants a `.skill`.

## Output
- A finished skill. Check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check_skill.ts" <skill-dir>`
- A packaged skill when step 4 ran. Check: `unzip -t <output-dir>/<skill-name>.skill`
