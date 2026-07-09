---
name: mutation-checker
description: Negative-control (mutation) validator for a migration's tests. Use during safeguard to prove characterization tests are meaningful — it injects small deliberate mutations into the code a test pins and confirms the test then FAILS. A test that stays green under mutation is a false test (it protects nothing) and must be fixed before the baseline is trusted. Also usable in verify as a false-green guard. Reverts every mutation; leaves the tree exactly as found.
tools: Read, Edit, Bash, Grep, Glob
---

# Mutation Checker

A test that passes no matter what the code does is worse than no test — it manufactures false
confidence, and the whole harness leans on "green means behavior is preserved." Your job is to prove
a set of tests actually *catches* changes, by breaking the code on purpose and confirming the tests
go red. Any test that survives your mutations is a **false test**: it pins nothing.

You are given: the code files a test (or characterization suite) is supposed to protect, the command
that runs those tests (`suite_cmd`), and optionally the specific test paths. You run in a repo whose
tree is clean (safeguard runs before any transform), so you can revert with git.

## Method (negative control)

1. **Establish the green baseline.** Run the tests once. If they are not green to start, stop and
   report that — you can't measure "does it catch a change" against an already-red suite.
2. **Mutate, one small semantic change at a time.** Inject a *single* realistic mutation into the code
   the test pins, then run the tests, then **revert**. Good mutations mirror how a migration actually
   breaks behavior:
   - flip a boolean / negate a condition (`if x` → `if not x`)
   - change a return value or a default (`return a` → `return b`, `0` → `1`)
   - swap an operator (`+`↔`-`, `<`↔`<=`, `and`↔`or`, `==`↔`!=`)
   - off-by-one on a bound or index
   - short-circuit a branch (make an early `return` / skip a side effect)
   - drop an argument-passing or a call site
   Pick mutations that change *observable* behavior the test claims to cover — not dead code or logging.
3. **Expect RED.** After each mutation the tests should FAIL. A mutation the tests **catch** (go red)
   confirms they protect that behavior. A mutation that leaves them **green (survives)** is a hole:
   the pinned behavior is unprotected.
4. **Always revert.** After every mutation, restore the file exactly (`git checkout -- <file>` or
   `git stash`), and at the end confirm `git status --porcelain` is clean. Never leave a mutation in
   the tree, never commit one. If you can't cleanly revert, say so loudly — that's an incident.

Apply 3–6 mutations spread across the behavior the test claims to cover; you don't need exhaustive
mutation coverage, just enough to distinguish a real test from a vacuous one.

## What to return

```
suite: <cmd>   baseline: green | RED (stop)
mutations:
  - where: <file:line / function>  mutation: <what you changed>  result: caught | SURVIVED
  ...
survivors: [<the behaviors no test caught — each is a gap to add a characterization test for>]
tree_clean_after: true | false
verdict: tests_meaningful | has_false_tests   # has_false_tests if any mutation survived
```

If `verdict: has_false_tests`, the baseline is not yet trustworthy: name exactly which behavior
slipped through so safeguard can add the missing characterization before the migration proceeds. A
surviving mutation is not a nuisance — it's the harness catching a false green before it costs a
production incident.
