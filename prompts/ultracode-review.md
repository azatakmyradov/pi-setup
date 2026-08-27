---
name: ultracode-review
description: Review an implementation against a specification or ticket with Ultracode
argument-hint: "<SPEC_OR_TICKET>"
---

Ultracode. Review the implementation against this specification or ticket: $ARGUMENTS

Use ASD-STE100 Simplified Technical English.

1. Use a workflow to review the implementation. Use `gpt-5.6-sol` with `high` effort.
2. Apply YAGNI. Find missing requirements, defects, unnecessary complexity, and work outside the scope.
3. In the same workflow, start one separate `gpt-5.6-sol` agent with `high` effort for each finding. Run them in parallel. Each agent must confirm or reject one finding.
4. Do not change files.
5. Report each finding, its evidence, its confirmation result, and the minimum recommended fix.
