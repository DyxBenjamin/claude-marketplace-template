---
summary: Rules for drafting a SKILL.md, its description, frontmatter, bundled files and instruction style
tags: [skill-creator, write-skill, skills]
related: [plugins/base-plugin/skills/write-skill/SKILL.md, plugins/base-plugin/scripts/check_skill.ts, plugins/base-plugin/scripts/verbs.txt]
---

# Skill writing guide

Claude reads this file while drafting or revising a SKILL.md and its bundled files.

## Skill template
The draft follows these rules, which `check_skill.ts` verifies:
- One skill, one objective, stated on an `Objective:` line. A request with several results becomes several
  skills plus one orchestrator whose Steps only chain them.
- The name is `<verb>-<object>` (or `<verb>-<object>-<qualifier>`), at most 24 characters, the verb from
  `${CLAUDE_PLUGIN_ROOT}/scripts/verbs.txt`, equal to the folder name.
- `description` states the result produced, at most 250 characters, with no "use when". `when_to_use` holds the
  literal trigger phrases and the relation to the nearest skill (`Complement of <skill>: use when <case>.` or
  `Variant of <skill> for <case>.`); the two together stay within 600 characters.
- `## Steps`: at most 10 numbered steps in a fixed order, each one action with one result, exact paths and
  commands. `## Output` lists what exists when done, each item with a `Check:` command.
- SKILL.md is at most 100 lines of at most 120 characters. What one path needs lives in a sibling one level deep
  that SKILL.md names together with the moment to read it; no doc subfolders.
- The body says that Claude runs its Steps as `delegate.md` says.

```markdown
---
name: <verb>-<object>
description: '<Produces X>.'
when_to_use: 'Use when "<phrase>", "<phrase>". Complement of <skill>: use when <case>.'
argument-hint: '<input; omit the field when there is none>'
---
# <Title>

Objective: <one verifiable result>.

Claude runs the Steps as `delegate.md` says.

## Steps
1. <one action with one result>

## Output
- <what exists when done>. Check: `<command that proves the Objective>`
```

## Description
The description is the main triggering mechanism, so it names what the skill produces and the contexts it serves.
Claude tends to undertrigger skills, so the trigger phrases in `when_to_use` are a little pushy and cover the
cases where the user does not name the skill: "dashboards, data visualization, internal metrics, or any display of
company data, even without the word 'dashboard'". `compatibility` lists required tools and dependencies, when any.

## Claude Code frontmatter
These fields are Claude Code-only (https://code.claude.com/docs/en/skills); a skill packaged with
`package_skill.ts` or uploaded to Claude.ai fails with a hard error when it has them. A skill meant for both keeps
to `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
- `when_to_use`: trigger context appended to `description`; the two are truncated together at 1,536 characters in
  the skill listing, so the key use case comes first.
- `disable-model-invocation: true`: only the user invokes the skill through `/skill-name`. For deliberate or
  side-effecting workflows (a setup routine, `/deploy`, `/commit`) that must not fire by coincidence.
- `user-invocable: false`: only Claude invokes it; it is no `/command`. For background knowledge.
- Without either flag, both the user and Claude invoke the skill.

## Anatomy and progressive disclosure
A skill folder holds `SKILL.md` (frontmatter with `name` and `description`, then instructions), and optional
bundled files: scripts for deterministic or repeated work, sibling docs loaded when a path needs them, and assets
used in the output (templates, icons, fonts). It loads in three levels: metadata (always in context, about 100
words), the SKILL.md body (whenever the skill triggers), bundled files (as needed; scripts run without loading).
- SKILL.md names each bundled file with the moment to read it.
- A sibling over 300 lines opens with a table of contents.
- A skill serving several domains or frameworks keeps one sibling per variant (`aws.md`, `gcp.md`, `azure.md`)
  next to the workflow and selection in SKILL.md; Claude reads only the relevant one.

## Writing patterns
- Instructions are third-person native register: "Claude does X; when Y, Claude ...". No second person, no
  persona, no all-caps urgency.
- Output formats are given as an exact template (`# [Title]`, `## Executive summary`, `## Key findings`).
- Examples help; the usual form is `Input:` and `Output:` pairs (for a commit message: "Added user authentication
  with JWT tokens" becomes "feat(auth): implement JWT-based authentication"), adapted when the case is not
  naturally input and output.

## Style
Claude explains why each thing matters instead of leaning on heavy-handed commands, uses theory of mind, and keeps
the skill general rather than narrowed to the examples. It writes a draft, then rereads it with fresh eyes and
improves it.
