---
name: write-skill
description: 'Writes a draft SKILL.md for a new or existing skill from the captured intent, with embedded delegation,
  2-3 test prompts in evals/evals.json, and a clean skill-rules check.'
when_to_use: 'Use when "write a skill", "turn this into a skill", "draft a SKILL.md", "edit this skill",
  "escribe una skill", "convierte esto en una skill". Complement of test-skill: use before it to produce the
  draft it tests. Step 1 of new-skill.'
argument-hint: '<skill name or the workflow to capture>'
---
# Write skill

> Modified from anthropics/skills skill-creator (Apache-2.0); original terms in `LICENSE.txt`.

Objective: `<skill-dir>/SKILL.md` holds a draft the user confirmed, `<skill-dir>/delegate.md` and
`<skill-dir>/evals/evals.json` exist, and `check_skill.ts` reports no violation for the skill.

Claude runs the Steps as `delegate.md` says.

Claude reads the user's familiarity from context cues: "evaluation" and "benchmark" are acceptable as they are;
"JSON" and "assertion" are used unexplained only once the user shows they know them. When in doubt, Claude adds a
short definition.

## Steps
1. Capture intent. When the conversation already holds the workflow ("turn this into a skill"), Claude extracts
   the tools used, the step sequence, the user's corrections and the input and output formats first; the user
   fills the gaps and confirms. Settled answers: what the skill enables, when it triggers (phrases and
   contexts), the output format, and whether test cases verify it: objectively verifiable outputs (file
   transforms, extraction, code generation, fixed workflow steps) get them, subjective ones (style, art) often do
   not. Claude suggests the default that fits, and the user decides.
2. Interview: Claude raises edge cases, input and output formats, example files, success criteria and
   dependencies before the user has to, and writes no test prompt until they are settled. An available MCP that
   helps research (docs, similar skills, best practices) is queried in parallel through subagents, or inline.
3. Resolve the target: `<skill-dir>` (`skills/<name>/` in a plugin, `.claude/skills/<name>/` in a project), the
   unit's agents folder (`agents/` or `.claude/agents/`), and its builder subagent type (`<plugin>:builder` or
   `builder`). Updating an existing skill keeps its folder name and `name` field unchanged.
4. Read `writing.md` before drafting, then write `<skill-dir>/SKILL.md` from the Skill template in it.
5. Embed delegation:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/embed_delegation.ts" <skill-dir> <builder-type> <agents-dir>`.
6. Validate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check_skill.ts" <skill-dir>`. Each `FAIL` line is fixed in the
   draft and the check reruns until it prints nothing.
7. Reread the draft with fresh eyes as its future reader and tighten it; rerun step 6.
8. Write 2-3 realistic test prompts, the kind a real user types, and share them with the user in plain words for
   additions. Save them to `<skill-dir>/evals/evals.json` with prompts only: `skill_name`, and per eval `id`,
   `prompt`, `expected_output`, `files`. Assertions come later, in test-skill.

A skill holds no malware, exploit code or anything that could compromise system security, and its contents match
the intent its description states. Claude declines misleading skills and skills built for unauthorized access,
data exfiltration or other malicious activity; a "roleplay as an XYZ" skill is fine.

## Output
- Draft that passes the skill rules. Check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check_skill.ts" <skill-dir>`
- Delegation embedded. Check: `test -f <skill-dir>/delegate.md && test -f <agents-dir>/builder.md`
- Test prompts saved. Check: `node -e 'JSON.parse(fs.readFileSync(process.argv[1]))' <skill-dir>/evals/evals.json`
