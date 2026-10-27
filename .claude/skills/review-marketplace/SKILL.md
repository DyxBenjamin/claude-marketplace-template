---
name: review-marketplace
description: 'Reports whether the repo passes what CI checks (sync drift, strict validation, mod tests, typecheck,
  vendored zod, version and name rules, leftover placeholders), as a verdict with one line per failure, without
  changing files.'
when_to_use: 'Use when "valida el marketplace", "revisa antes de pushear", "corre el CI local", "por qué falla el
  validate", "check the marketplace". Complement of ship-plugin: run before it. Complement of new-plugin and
  new-component: their own checks cover one plugin, this one the whole repo.'
---
# Review marketplace

Objective: a verdict, `ok` or the list of failures with the fix for each, from `review.sh`.

## Steps
1. Run `.claude/skills/review-marketplace/review.sh` from the repo root. The script decides; Claude reports its
   `FAIL` and `WARN` lines and never re-derives them by hand. It works on a temporary copy, so the working tree
   stays untouched. It is a wrapper of `review.ts`. Its rule lines (`format`, `data`, `language`, `tone`, `tech`,
   `zod`, `tools`, `license`) come from `check-rules.ts`, which checks the mechanical part of `rules.md` against the
   types in `allowed-ext.txt`.
2. Read `rules.md` and report, per plugin, the rules a script cannot decide (an agent contract's shape, history in
   docs, network calls the README does not name).
3. For each `FAIL`, name the fix and the skill that applies it: a stale catalog needs
   `node scripts/generate-release-config.ts`; a validation error is fixed in the file `validate` names (rerun
   `claude plugin validate <path> --strict` for the full message); a failing mod test points at the hook under
   test; a `typecheck` error is fixed in the file `tsc` names; a stale `vendor` copy needs `npm run vendor`; a
   version in a marketplace entry is deleted; a name mismatch is fixed in the entry or in `plugin.json`;
   a plugin-rule failure is fixed as `rules.md` says, in the file the line names.
4. A `WARN placeholder` line is expected in the template itself; in a marketplace made from it, offer
   `new-marketplace`.
5. Claude applies fixes only when the user asks, then reruns the script until it prints `ok`.

## Output
- Verdict printed. Check: `.claude/skills/review-marketplace/review.sh` exits 0 and prints `ok`, or the reported
  failures match its `FAIL` lines.
