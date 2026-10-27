---
name: new-marketplace
description: 'Fills the template identity (marketplace name, owner, plugin authors, install lines) so no CHANGE_ME
  placeholder is left and strict validation passes.'
when_to_use: 'Use when "configura el marketplace", "usé el template", "reemplaza los CHANGE_ME", "set up this
  marketplace", "rename the marketplace". Complement of new-plugin: runs once, before it.'
argument-hint: '[marketplace-name] [owner/repo]'
---
# New marketplace

Objective: no `CHANGE_ME` left outside `.claude/skills/`, and `claude plugin validate . --strict` passes.

Claude runs the Steps as `delegate.md` says.

## Steps
1. List the placeholders: `git grep -n CHANGE_ME -- ':!.claude/skills'`.
2. Prefill the answers from `$ARGUMENTS`, `git config user.name`, `git config user.email` and
   `git remote get-url origin`. Ask once, in one message, for what is still missing: marketplace name, owner name
   and email, GitHub `owner/repo`. Plugin authors default to the owner.
3. Check the marketplace name: lowercase letters, digits, `.`, `_`, `-`, starting with a letter or digit. It must not
   be an official Anthropic name (such as `claude-plugins-official` or `anthropic-marketplace`), start with
   `claudeai-`, or imitate another organization. `validate` accepts reserved names; Claude Code refuses them only
   when a user adds the marketplace, so this step is the only guard.
4. Replace every placeholder in place:
   - `.claude-plugin/marketplace.json`: `name`, `owner.name`, `owner.email`, and a `description` of this marketplace.
   - Each `plugins/*/.claude-plugin/plugin.json`: `author.name`, `author.email`.
   - `CLAUDE.md`: the `author` of the `plugin.json` template.
   - `README.md`: the install lines become `/plugin marketplace add <owner/repo>` and
     `/plugin install <plugin>@<marketplace-name>`. Remove the Setup section: it describes the template, not
     this marketplace.
5. Run `npm ci` first, then `node scripts/generate-release-config.ts`, then `claude plugin validate . --strict`.
   Fix until it passes.
6. Tell the user the GitHub settings no file can set:
   - Settings → Actions → General: allow all actions, workflow permissions "Read and write", and "Allow GitHub
     Actions to create and approve pull requests". Without them the release workflow fails with a 403.
   - `main` without rules that require a PR, signed commits or linear history: the release bot pushes to it.
   - Repository secret `ANTHROPIC_API_KEY`, only if the Evals workflow will run.
   - Users get updates without asking by enabling auto-update for this marketplace in `/plugin` → Marketplaces.

## Output
- Identity filled and the catalog valid. Check:
  `! git grep -q CHANGE_ME -- ':!.claude/skills' && claude plugin validate . --strict`
