---
summary: Packages a finished skill into a .skill file with package_skill.ts and presents it when present_files exists
tags: [skill-creator, packaging]
related: [plugins/base-plugin/skills/skill-creator/scripts/package_skill.ts]
---

# Package and present

Claude packages a skill only when the `present_files` tool is available; without it, Claude skips this step.

With `present_files`, Claude packages the skill and presents the `.skill` file to the user:

```bash
node <skill-creator-path>/scripts/package_skill.ts <path/to/skill-folder>
```

After packaging, Claude points the user to the resulting `.skill` file path so they can install it.

The packager needs only Node and a filesystem, so it runs in Claude Code, Cowork and Claude.ai alike. A skill
whose frontmatter carries Claude Code-only fields (`when_to_use`, `disable-model-invocation`, `user-invocable`)
fails packaging or Claude.ai upload with a hard error.
