---
name: ship-skill
description: 'Packages a finished skill folder into a validated .skill archive the user installs or uploads, and
  points the user to its path.'
when_to_use: 'Use when "package the skill", "make a .skill file", "upload this skill to claude.ai", "export the
  skill", "empaqueta la skill". Complement of fix-description: use after it, on the finished skill. Step 4 of
  new-skill.'
argument-hint: '<skill-dir> [output-dir]'
---
# Ship skill

> Modified from anthropics/skills skill-creator (Apache-2.0); original terms in `LICENSE.txt`.

Objective: `<output-dir>/<skill-name>.skill` exists, passes `unzip -t`, and the user has its path.

Claude runs the Steps as `delegate.md` says.

Claude packages a skill when the `present_files` tool is available or the user asks for a `.skill` file;
otherwise it skips this skill. The packager needs only Node and a filesystem, so it runs in Claude Code, Cowork
and Claude.ai alike. Outside Claude Code, Claude reads `platforms.md` first.

## Steps
1. Validate the frontmatter: `node "${CLAUDE_PLUGIN_ROOT}/scripts/quick_validate.ts" <skill-dir>`. A Claude
   Code-only field (`when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint`, ...) fails
   packaging and Claude.ai upload with a hard error; Claude tells the user which field blocks it and, when the
   skill is meant for both, moves its content into `description` and removes the field.
2. When updating an installed skill, keep its folder name and `name` field (`research-helper` packages as
   `research-helper.skill`, never `research-helper-v2`), and copy it into a fresh `mktemp -d` folder first: the
   installed path may be read-only. Claude edits and packages from that copy.
3. Package: `node "${CLAUDE_PLUGIN_ROOT}/scripts/package_skill.ts" <skill-dir> <output-dir>`. It reruns the
   validation, skips `evals/` at the skill root, `node_modules`, `__pycache__`, `.DS_Store` and `.pyc`, and writes
   `<skill-name>.skill`. When writing to the output directory directly fails for lack of permissions, Claude
   packages into a `mktemp -d` folder and copies the file over.
4. Verify the archive with `unzip -t`, then present the file with `present_files` when available, or give the
   user its path to install or download.

## Output
- Archive in place and intact. Check: `unzip -t <output-dir>/<skill-name>.skill`
