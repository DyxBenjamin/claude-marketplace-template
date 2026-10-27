---
summary: Guides drafting a SKILL.md and its bundled files, covering frontmatter, anatomy, progressive disclosure and style
tags: [skill-creator, skills]
---

# Skill writing guide

Claude reads this file while drafting or revising a skill's SKILL.md and its bundled files.

## Claude Code frontmatter

In Claude Code a skill is also a `/skill-name` command. These fields are Claude Code-only (see
https://code.claude.com/docs/en/skills): a skill packaged with `package_skill.ts` or uploaded to Claude.ai fails
with a hard error when it has them.

- `when_to_use`: extra trigger context appended to `description`. The two together are truncated at 1,536
  characters in the skill listing, so the key use case comes first.
- `disable-model-invocation: true`: only the user invokes the skill, via `/skill-name`; Claude never triggers it
  automatically. For deliberate or side-effecting workflows (a setup routine, `/deploy`, `/commit`) that must not
  fire by coincidence.
- `user-invocable: false`: only Claude invokes the skill; it does not appear as a `/command`. For background
  knowledge that is not a user-facing action.

Without either invocation flag, both the user and Claude can invoke the skill.

## Anatomy of a skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

## Progressive disclosure

A skill loads in three levels:

1. **Metadata** (name + description): always in context (about 100 words)
2. **SKILL.md body**: in context whenever the skill triggers (under 500 lines is ideal)
3. **Bundled resources**: loaded as needed (no limit; scripts run without being loaded)

The word counts are approximate; a skill goes longer when it needs to.

**Key patterns:**

- SKILL.md stays under 500 lines. A skill nearing that limit gains a layer of hierarchy, with clear pointers telling
  the model where to go next.
- SKILL.md references each bundled file clearly, saying when to read it.
- A reference file over 300 lines opens with a table of contents.

**Domain organization**: a skill that supports several domains or frameworks is organized by variant:

```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

Claude then reads only the relevant reference file.

## Writing patterns

Instructions use the imperative form.

**Defining output formats**, for example:

```markdown
## Report structure
Use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern**: examples help. One format follows; when the examples are not naturally "Input" and
"Output", the format adapts:

```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

## Writing style

Claude explains to the model why each thing matters instead of leaning on heavy-handed all-caps commands. It uses
theory of mind and keeps the skill general rather than narrowed to specific examples. It writes a draft, then
reads it with fresh eyes and improves it.
