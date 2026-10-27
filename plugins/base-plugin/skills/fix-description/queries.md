---
summary: Format and writing rules for the should-trigger and should-not-trigger queries of a description eval
tags: [skill-creator, description-optimization, trigger, evals]
related: [plugins/base-plugin/skills/fix-description/SKILL.md, plugins/base-plugin/scripts/run_eval.ts]
---

# Trigger queries

Claude reads this file at step 1 of fix-description.

## How triggering works
Skills appear in Claude's `available_skills` list with their name and description, and Claude decides from that
description whether to consult one. Claude consults skills only for tasks it cannot easily handle alone: a
one-step query like "read this PDF" may trigger no skill even when the description matches, because basic tools
handle it. Complex, multi-step or specialized queries reliably trigger a matching skill. So each query is
substantive enough that consulting a skill would help; "read file X" tests nothing.

## Format
A JSON array:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

## Writing them
- Realistic: what a Claude Code or Claude.ai user would actually type. Concrete and specific, with detail: file
  paths, personal context about the job or situation, column names and values, company names, URLs, a little
  backstory. Some lowercase, some with abbreviations, typos or casual speech; lengths vary. The set leans on edge
  cases over clear-cut ones.
- Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`.
- Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final
  FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in
  column C and costs are in column D i think"`.

## Should trigger (8-10)
The intent from several angles: different phrasings, formal and casual; requests that never name the skill or
file type but clearly need it; uncommon use cases; cases where this skill competes with another and should win.

## Should not trigger (8-10)
Mostly near-misses: queries that share keywords or concepts with the skill but need something else. Adjacent
domains, ambiguous phrasing a naive keyword match would trigger on, and requests that touch what the skill does in
a context where another tool fits better. An obviously irrelevant negative ("Write a fibonacci function" for a PDF
skill) tests nothing; the negatives are genuinely tricky.
