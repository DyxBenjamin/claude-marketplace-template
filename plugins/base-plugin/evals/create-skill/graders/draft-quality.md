---
type: llm
---

PASS if the final response does one of these:
- shows a SKILL.md draft with YAML frontmatter containing `name` and `description`, where the description says when the skill applies (reviewing database migration PRs) and the body covers the four checklist items; or
- asks the user specific questions needed to write that skill, such as when it should trigger or what output format the review should have.

FAIL if the response only restates the checklist, writes a generic code review answer, or ignores the request to make it reusable.
