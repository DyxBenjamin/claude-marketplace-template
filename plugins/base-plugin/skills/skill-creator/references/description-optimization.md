---
summary: Defines the procedure that writes trigger eval queries, reviews them and runs the description optimization loop
tags: [skill-creator, description-optimization, trigger, evals]
related: [plugins/base-plugin/skills/skill-creator/scripts/run_loop.ts, plugins/base-plugin/skills/skill-creator/scripts/run_eval.ts]
---

# Description optimization

The `description` field in the SKILL.md frontmatter is the main mechanism that decides whether Claude invokes a
skill. Claude runs this procedure once the skill is finished and the user agrees it is in good shape. It needs the
`claude` CLI (`claude -p`), so it runs in Claude Code and Cowork, not in Claude.ai.

## How skill triggering works

Skills appear in Claude's `available_skills` list with their name and description, and Claude decides from that
description whether to consult a skill. Claude consults skills only for tasks it cannot easily handle on its own:
a simple one-step query like "read this PDF" may not trigger a skill even when the description matches perfectly,
because basic tools handle it directly. Complex, multi-step or specialized queries reliably trigger a skill whose
description matches.

So eval queries are substantive enough that Claude would benefit from consulting a skill. Simple queries like
"read file X" are poor test cases: they trigger no skill whatever the description says.

## Step 1: Generate trigger eval queries

Claude writes 20 eval queries, a mix of should-trigger and should-not-trigger, saved as JSON:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries are realistic: something a Claude Code or Claude.ai user would actually type. Not abstract requests,
but concrete, specific ones with detail: file paths, personal context about the user's job or situation, column
names and values, company names, URLs, a little backstory. Some are lowercase or carry abbreviations, typos or
casual speech. Lengths vary, and the set leans on edge cases rather than clear-cut ones (the user signs off on
them in step 2).

Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`

Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

**Should-trigger queries (8-10)** cover the intent from several angles: different phrasings, some formal, some
casual; cases where the user does not name the skill or file type but clearly needs it; uncommon use cases; and
cases where this skill competes with another but should win.

**Should-not-trigger queries (8-10)** are mostly near-misses: queries that share keywords or concepts with the
skill but need something different. Adjacent domains, ambiguous phrasing where a naive keyword match would
trigger but should not, and cases where the query touches what the skill does in a context where another tool
fits better. An obviously irrelevant negative ("Write a fibonacci function" for a PDF skill) tests nothing; the
negatives are genuinely tricky.

## Step 2: Review with the user

Claude presents the eval set for review with the HTML template:

1. Read the template from `assets/eval_review.html`.
2. Replace the placeholders:
   - `__EVAL_DATA_PLACEHOLDER__` → the JSON array of eval items (no quotes around it: it is a JS variable
     assignment)
   - `__SKILL_NAME_PLACEHOLDER__` → the skill's name
   - `__SKILL_DESCRIPTION_PLACEHOLDER__` → the skill's current description
3. Write it to the workspace as `<workspace>/eval_review.html` and open it: `open <workspace>/eval_review.html`
4. The user edits queries, toggles should-trigger, adds or removes entries, then clicks "Export Eval Set".
5. The file downloads to `~/Downloads/eval_set.json`. Claude checks the Downloads folder for the most recent
   version in case there are several (for example `eval_set (1).json`).

This step matters: bad eval queries produce bad descriptions.

## Step 3: Run the optimization loop

Claude tells the user the loop takes a while and runs in the background, with periodic updates.

It saves the eval set to the workspace, then runs in the background:

```bash
node <skill-creator-path>/scripts/run_loop.ts \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id-powering-this-session> \
  --max-iterations 5 \
  --verbose
```

`--model` takes the model ID from Claude's own system prompt (the one powering the current session), so the
triggering test matches what the user experiences.

While it runs, Claude tails the output now and then to tell the user which iteration it is on and how the scores
look.

The script runs the whole loop. It splits the eval set into 60% train and 40% held-out test, evaluates the current
description (running each query 3 times for a reliable trigger rate), then calls Claude to propose improvements
from what failed. It re-evaluates each new description on both train and test, up to 5 iterations. At the end it
opens an HTML report in the browser with the results per iteration and returns JSON with `best_description`,
selected by test score rather than train score to avoid overfitting.

## Step 4: Apply the result

Claude takes `best_description` from the JSON output, updates the skill's SKILL.md frontmatter, shows the user the
before and after, and reports the scores.
