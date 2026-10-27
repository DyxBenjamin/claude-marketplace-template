---
name: ship-plugin
description: 'Commits plugin changes on a branch, one conventional commit per plugin with the prefix that yields the
  intended version bump, and opens a pull request whose title the release workflow reads.'
when_to_use: 'Use when "publica el plugin", "haz el release", "commitea y abre el PR", "sube los cambios del
  plugin", "ship this plugin". Complement of review-marketplace: runs after it prints ok.'
argument-hint: '[plugin] [patch|minor|major]'
---
# Ship plugin

Objective: the changes are committed on a non-default branch with a conventional subject per plugin, and an open
pull request into `main` carries the same conventional title.

## Steps
1. Run `.claude/skills/review-marketplace/review.sh`; any `FAIL` stops here and goes to `review-marketplace`.
2. Group the changed files (`git status --short`, or `git diff --name-only main...` on a branch) by plugin folder.
   The release workflow assigns a commit to a plugin by the paths it touches, so each plugin gets its own commit, and
   changes outside `plugins/` get their own commit with `ci:`, `docs:` or `chore:`, which release nothing.
3. Pick each plugin's prefix from what changed and from `$ARGUMENTS`:
   - `fix:` gives a patch, for a correction that changes no interface.
   - `feat:` gives a minor, for a new skill, agent, hook, command or option.
   - `feat!:` or a `BREAKING CHANGE:` footer gives a major, for a renamed or removed skill or command, a changed
     `userConfig` key, or a hook that now blocks what it allowed.
   - `docs:`, `refactor:`, `test:`, `chore:` release nothing on their own.
   When the user's intended bump and the changes disagree, Claude says so and asks which one holds.
4. On `main`, create a branch first: `<type>/<plugin>-<short-slug>`.
5. Commit each group with `git add <its paths>` and a subject `<type>(<plugin>): <what changed>`; the body says
   why. The commit message ends with the attribution lines the session requires.
6. Ask before pushing, because a push and a pull request are visible to others. Then `git push -u origin <branch>`
   and `gh pr create --base main --title "<the commit subject>" --body "<what and why>"`. With several plugins,
   the title takes the highest bump. Squash merges keep only the PR title, so it must stay conventional.
7. Tell the user what follows the merge: the release workflow opens one release PR per bumped plugin; merging it
   bumps `plugin.json`, writes the changelog, and tags the plugin release.

## Output
- Conventional commits on a branch. Check:
  `git log main..HEAD --format=%s | grep -Ev '^(feat|fix|perf|docs|refactor|test|chore|ci)(\(.+\))?!?: ' | wc -l`
  prints `0`, and `git branch --show-current` is not `main`.
- Pull request open with a conventional title. Check:
  `gh pr view --json title -q .title | grep -Eq '^(feat|fix|perf|docs|refactor|test|chore|ci)(\(.+\))?!?: '`
