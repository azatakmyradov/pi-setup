---
name: ultracode-ticket
description: Implement and review a ticket with Ultracode
argument-hint: "<TICKET>"
---

Ultracode. Implement this ticket: $ARGUMENTS

Use ASD-STE100 Simplified Technical English.

1. Implement the minimum solution and run the relevant checks.
2. Use a workflow to review the implementation. Use `gpt-5.6-sol` with `high` effort. Apply YAGNI. Find missing requirements, defects, unnecessary complexity, and work outside the ticket scope.
3. In the same workflow, start one separate `gpt-5.6-sol` agent with `high` effort for each finding. Run them in parallel. Each agent must confirm or reject one finding.
4. Fix each confirmed finding with red-green-refactor. Do not fix rejected findings.
5. Run all relevant tests and checks.
6. Mark the ticket as completed.
7. Report the implementation, findings, confirmation results, fixes, and final check results.
