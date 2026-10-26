---
description: A request to turn a repeated checklist into a skill fires skill-creator and produces a usable SKILL.md draft or targeted intake questions.
tags: [skill-creator, trigger]
max_turns: 15
allowed_tools: [Read, Glob, Grep, Skill]
---

Every time I review a database migration PR I paste the same checklist into the chat: check for a down migration, no column drops without a deprecation window, indexes created concurrently, and no data backfills inside the schema migration. Can you turn that into something reusable so I don't have to paste it anymore?
