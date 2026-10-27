---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use whenever the user wants to create a skill from scratch, turn a workflow into a skill, edit or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy, even when they do not say "skill-creator".
---

> **Modified from the original.** Derived from Anthropic's `skill-creator` (anthropics/skills, Apache-2.0): the
> instruction files are rewritten in third-person register and split into `references/`, the scripts are ported
> from Python to Node, the eval workspace lives in the project's `.claude/base-plugin/`, and a "Claude Code
> frontmatter" section is added to `references/skill-writing.md`. Original terms in `LICENSE.txt`.

# Skill Creator

Claude creates new skills and improves them iteratively. The process:

- Decide what the skill does and roughly how it does it
- Write a draft of the skill
- Write a few test prompts and run Claude with access to the skill on them
- Evaluate the results with the user, qualitatively and quantitatively
  - While the runs happen in the background, Claude drafts quantitative evals when there are none (existing ones
    it uses as they are or adjusts where needed), then explains them to the user
  - Claude shows the results with `eval-viewer/generate_review.ts`, along with the quantitative metrics
- Rewrite the skill from the user's evaluation (and from any glaring flaw the benchmarks expose)
- Repeat until the skill is good
- Expand the test set and try again at larger scale

Claude works out where the user is in this process and helps from there. A user who says "I want to make a skill
for X" gets help narrowing what they mean, a draft, test cases, a choice of evaluation, the runs, and the
iterations. A user who already has a draft goes straight to the eval/iterate loop. The order is flexible: a user
who wants no evaluations, just collaboration, gets that instead. Once the skill is done, Claude also offers the
description optimizer, which tunes the skill's triggering.

## Communicating with the user

Users of this skill range widely in familiarity with coding jargon: some are new to the terminal, most are fairly
computer-literate. Claude reads the context cues and phrases accordingly. By default:

- "evaluation" and "benchmark" are borderline but acceptable
- "JSON" and "assertion" need clear cues that the user knows them before Claude uses them unexplained

When in doubt, Claude adds a short definition of the term.

---

## Creating a skill

### Capture intent

Claude starts by understanding the user's intent. The conversation may already hold a workflow the user wants to
capture ("turn this into a skill"). Then Claude extracts answers from the conversation history first: the tools
used, the sequence of steps, the corrections the user made, the input and output formats observed. The user fills
the gaps and confirms before the next step.

1. What should this skill enable Claude to do?
2. When should this skill trigger? (which user phrases and contexts)
3. What is the expected output format?
4. Should test cases verify the skill? Skills with objectively verifiable outputs (file transforms, data
   extraction, code generation, fixed workflow steps) benefit from test cases; skills with subjective outputs
   (writing style, art) often do not. Claude suggests the default that fits the skill type, and the user decides.

### Interview and research

Claude asks about edge cases, input and output formats, example files, success criteria and dependencies before
the user has to raise them, and holds off on test prompts until these are settled.

Claude checks the available MCPs. When one helps research (searching docs, finding similar skills, looking up
best practices), Claude researches in parallel through subagents when available, otherwise inline, and comes
prepared with context to reduce the burden on the user.

### Write the SKILL.md

From the interview, Claude fills in these components:

- **name**: skill identifier
- **description**: when to trigger and what the skill does. This is the main triggering mechanism, so it names both
  what the skill does and the specific contexts for using it; all "when to use" information goes here, not in the
  body. Claude tends to undertrigger skills, not using them when they would help, so the description is a little
  "pushy". Instead of "How to build a simple fast dashboard to display internal Anthropic data.", it reads "How to
  build a simple fast dashboard to display internal Anthropic data. Make sure to use this skill whenever the user
  mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if
  they don't explicitly ask for a 'dashboard.'"
- **compatibility**: required tools and dependencies (optional, rarely needed)
- **the rest of the skill**: written following [the skill writing guide](references/skill-writing.md), which
  covers the Claude Code-only frontmatter fields, the skill anatomy, progressive disclosure, writing patterns and
  style. Claude reads it before drafting.

A skill contains no malware, exploit code, or anything that could compromise system security, and its contents
match the intent its description states. Claude declines to create misleading skills or skills built for
unauthorized access, data exfiltration or other malicious activity. A "roleplay as an XYZ" skill is fine.

### Test cases

After the draft, Claude writes 2-3 realistic test prompts, the kind of thing a real user would say. It shares them
with the user in its own words, asking whether they look right or need additions, then runs them.

Claude saves the test cases to `evals/evals.json` with prompts only; it drafts the assertions in the next stage,
while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

The full schema, including the `assertions` field added later, is in [the JSON schemas](references/schemas.md).

## Running and evaluating test cases

This stage is one continuous sequence, and Claude runs it to the end without stopping partway. Claude runs it
itself rather than through another testing skill: the grader, the benchmark script and the viewer all read the
workspace layout below.

Results go in the project's `.claude/base-plugin/<skill-name>-workspace/` (the `<workspace>` below). Inside it,
results are organized by iteration (`iteration-1/`, `iteration-2/`, ...), and within an iteration each test case
gets a directory (`eval-0/`, `eval-1/`, ...). Claude creates directories as it goes, not all upfront.

### Step 1: Spawn all runs (with-skill and baseline) in the same turn

For each test case, Claude spawns two subagents in the same turn, one with the skill and one without. It does not
spawn the with-skill runs first and come back for baselines later: launching everything at once makes it all
finish around the same time.

**With-skill run:**

```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**Baseline run** (same prompt; the baseline depends on context):

- **Creating a new skill**: no skill at all. Same prompt, no skill path, saved to `without_skill/outputs/`.
- **Improving an existing skill**: the old version. Before editing, Claude snapshots the skill
  (`cp -r <skill-path> <workspace>/skill-snapshot/`) and points the baseline subagent at the snapshot, saved to
  `old_skill/outputs/`.

Claude writes an `eval_metadata.json` for each test case (assertions may be empty for now). Each eval gets a
descriptive name based on what it tests, not just "eval-0", and the directory uses that name too. When an
iteration uses new or modified eval prompts, Claude creates these files for each new eval directory; they do not
carry over from previous iterations.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: Draft assertions while the runs are in progress

Claude uses the wait productively: it drafts quantitative assertions for each test case and explains them to the
user. When `evals/evals.json` already has assertions, Claude reviews them and explains what they check.

Good assertions are objectively verifiable and have descriptive names, so they read clearly in the benchmark
viewer and someone glancing at the results understands what each one checks. Subjective skills (writing style,
design quality) are better evaluated qualitatively; Claude does not force assertions onto things that need human
judgment.

Claude updates the `eval_metadata.json` files and `evals/evals.json` with the drafted assertions, and explains
what the user will see in the viewer: the qualitative outputs and the quantitative benchmark.

### Step 3: Capture timing data as runs complete

When each subagent task completes, its notification carries `total_tokens` and `duration_ms`. Claude saves them at
once to `timing.json` in the run directory:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

This is the only chance to capture this data: it arrives in the task notification and is persisted nowhere else.
Claude processes each notification as it arrives rather than batching them.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run**: a grader subagent (or Claude inline) reads `agents/grader.md` and evaluates each assertion
   against the outputs, saving `grading.json` in each run directory. The `expectations` array of `grading.json`
   uses the fields `text`, `passed` and `evidence` (not `name`/`met`/`details` or other variants): the viewer
   depends on these exact names. An assertion that can be checked programmatically gets a script rather than an
   eyeball check: scripts are faster, more reliable and reusable across iterations.

2. **Aggregate into the benchmark**:
   ```bash
   node <skill-creator-path>/scripts/aggregate_benchmark.ts <workspace>/iteration-N --skill-name <name>
   ```
   This writes `benchmark.json` and `benchmark.md` with pass_rate, time and tokens for each configuration, as
   mean ± stddev, plus the delta. A `benchmark.json` written by hand follows the exact schema the viewer expects,
   in [the JSON schemas](references/schemas.md). Each with_skill version comes before its baseline counterpart.

3. **Analyst pass**: Claude reads the benchmark data and surfaces patterns the aggregate stats hide, following the
   "Analyzing Benchmark Results" section of `agents/analyzer.md`: assertions that pass regardless of the skill
   (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.

4. **Launch the viewer** with the qualitative outputs and the quantitative data:
   ```bash
   nohup node <skill-creator-path>/eval-viewer/generate_review.ts \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
   For iteration 2+, Claude also passes `--previous-workspace <workspace>/iteration-<N-1>`.

   **Headless environments**: when the environment has no display or the viewer cannot open a browser, Claude
   passes `--static <output_path>`, which writes a standalone HTML file instead of starting a server. Feedback then
   downloads as a `feedback.json` file when the user clicks "Submit All Reviews"; Claude copies it into the
   workspace directory for the next iteration to pick up.

   Claude builds the viewer with `generate_review.ts`, never with custom HTML, and generates it before evaluating
   or revising anything itself: the next revision is built on the user's review of these examples.

5. **Tell the user** that the results are open in the browser, in two tabs: "Outputs" to click through each test
   case and leave feedback, "Benchmark" for the quantitative comparison. Claude asks the user to come back to the
   conversation when done.

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time: **Prompt** (the task given), **Output** (the files the skill
produced, rendered inline where possible), **Previous Output** (iteration 2+, collapsed), **Formal Grades** (when
grading ran, collapsed assertion pass/fail), **Feedback** (a textbox that auto-saves as the user types) and
**Previous Feedback** (iteration 2+, the user's last comments, below the textbox). The "Benchmark" tab shows pass
rates, timing and token usage per configuration, with per-eval breakdowns and analyst observations. Navigation is
by prev/next buttons or arrow keys; "Submit All Reviews" saves all feedback to `feedback.json`.

### Step 5: Read the feedback

When the user says they are done, Claude reads `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user found that case fine. Claude focuses its improvements on the test cases with
specific complaints, and stops the viewer server once done with it:

```bash
kill $VIEWER_PID 2>/dev/null
```

---

## Improving the skill

This is the heart of the loop: the test cases ran, the user reviewed them, and Claude now improves the skill from
that feedback.

### How Claude thinks about improvements

1. **Generalize from the feedback.** The skill will run many times across many different prompts, while Claude and
   the user iterate on a few examples because that is fast: the user knows them well and judges new outputs
   quickly. A skill that works only for those examples is useless. Instead of fiddly, overfitted changes or
   oppressively rigid rules, a stubborn issue calls for branching out: different metaphors, different patterns of
   working. Trying is cheap, and one may land.

2. **Keep the prompt lean.** Claude removes what is not pulling its weight. It reads the transcripts, not just the
   final outputs: when the skill makes the model waste time on unproductive work, Claude removes the parts causing
   it and sees what happens.

3. **Explain the why.** Claude explains the reasoning behind everything the skill asks of the model. Current models
   have good theory of mind and, given a good harness, go beyond rote instructions. Even when the user's feedback
   is terse or frustrated, Claude works out the task, why the user wrote what they wrote, and what they actually
   wrote, and carries that understanding into the instructions. Rules in all caps or rigid structures are a yellow
   flag: Claude reframes them and explains why the thing matters, which is more humane, powerful and effective.

4. **Look for repeated work across test cases.** Claude reads the run transcripts for helper scripts or multi-step
   approaches the subagents all reinvented independently. When every test case had the subagent write a
   `create_docx.py` or a `build_chart.py`, the skill should bundle that script: Claude writes it once in
   `scripts/` and tells the skill to use it, saving every future invocation the work.

Claude writes a draft revision, then reads it anew and improves it, getting into the head of the user to
understand what they want and need.

### The iteration loop

After improving the skill, Claude:

1. Applies the improvements to the skill.
2. Reruns all test cases into a new `iteration-<N+1>/` directory, baselines included. For a new skill, the
   baseline is always `without_skill` (no skill) and stays the same across iterations. For an existing skill,
   Claude judges which baseline makes sense: the original version the user came in with, or the previous
   iteration.
3. Launches the viewer with `--previous-workspace` pointing at the previous iteration.
4. Waits for the user to review and say they are done.
5. Reads the new feedback, improves again, and repeats.

The loop continues until:

- The user says they are happy
- The feedback is all empty (everything looks good)
- The iterations stop making meaningful progress

---

## Blind comparison

When the user wants a more rigorous comparison between two versions of a skill ("is the new version actually
better?"), Claude runs a blind comparison: an independent agent gets the two outputs without knowing which is
which and judges their quality, as `agents/comparator.md` describes; then the post-hoc analysis in
`agents/analyzer.md` explains why the winner won. This is optional and needs subagents; the human review loop is
usually enough.

## Description optimization and packaging

After creating or improving a skill, Claude offers to optimize its description for better triggering accuracy,
following [description optimization](references/description-optimization.md). When the `present_files` tool is
available, Claude packages the finished skill as a `.skill` file following [packaging](references/packaging.md).

## Outside Claude Code

In Claude.ai or Cowork, Claude reads [the platform notes](references/platforms.md) before running test cases: they
adapt subagent runs, the viewer, benchmarking, packaging and updates of an installed skill.

## Reference files

`agents/` holds the instructions of the specialized subagents; Claude reads one when it spawns that subagent:
`agents/grader.md` (assertions against outputs), `agents/comparator.md` (blind A/B comparison) and
`agents/analyzer.md` (why one version won, and benchmark analysis). `references/` holds the material a path
needs, each file linked above at the moment it applies.

When a todo list is available, Claude adds the core loop to it (draft, run the test prompts, generate the viewer,
read the feedback, improve, package) so no step is skipped. In Cowork, the list carries "Create evals JSON and run
`eval-viewer/generate_review.ts` so human can review test cases".
