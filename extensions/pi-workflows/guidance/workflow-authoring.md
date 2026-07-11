# Workflow architecture guidance

Use this guidance only for writing a `workflow` tool script. The script is an async function body with `agent()`, `pipeline()`, `apply()`, `log()`, and `args`; it has no direct filesystem, shell, or network access.

## Think before writing the script

Design the workflow as a reasoning graph before emitting JavaScript. Agents are independent reasoning roles, not filenames, URLs, claims, test cases, or other collection items. A discovered list is evidence for planning; it is not automatically a fan-out list.

For every workflow:

1. Restate the objective and its completion criteria.
2. Identify the different kinds of reasoning needed (for example discovery, architecture, implementation, domain investigation, criticism, verification, and synthesis).
3. Identify dependencies between those reasoning stages.
4. Parallelize only work that is genuinely independent and benefits from separate context or perspective.
5. Choose the smallest useful number of agents. Prefer one well-contextualized agent over many agents doing overlapping work.
6. Explain the decomposition, fan-out rationale, expected agent count, and stop conditions in the tool's structured `plan` argument.
7. Then compile that plan into the script.

Do not use one agent per discovered item unless the items are truly independent, each can be handled with bounded context, and the `fanoutRationale` explicitly explains why item-level isolation is useful. Usually, cluster items by semantic responsibility, dependency, risk, hypothesis, or specialist perspective first.

## Dynamic planning

Prefer topology that adapts to evidence:

- Start with one structured scout/architect agent when the task boundaries are unclear.
- Have that agent return coherent work units, unresolved questions, risks, or hypotheses—not merely raw paths.
- Bound dynamic units with `.slice(0, maximum)` before `pipeline()`.
- Skip specialist stages when discovery shows they are unnecessary.
- Add critics or adjudicators only for consequential claims, conflicting evidence, or write-capable results.
- Stop early when completion criteria are met; do not spend the declared budget merely because it exists.

## Design rules

1. Discover and model the work before fan-out. Prefer a schema-returning architecture agent over guessing paths or copying a raw inventory into `pipeline()`.
2. Make every subagent prompt self-contained: include the goal, relevant paths or inputs, constraints, and exact output format. Subagents do not share conversation context or memory.
3. Use schemas whenever another script stage consumes the response. Ask prose-only agents for compact findings, not copied files.
4. Use `pipeline(items, fn)` only for independent reasoning units and always handle `null` failures with `.filter(Boolean)`.
5. Keep fan-out bounded both in the plan and script. Consolidate large collections into sensible semantic batches.
6. Avoid duplicate context: if several agents need the same broad repository understanding, produce it once and pass a compact structured result onward.
7. Use `lean: true` only for self-contained, read-only work that needs no extension tools, skills, context files, or project guidance.
8. Specify the narrowest tool allowlist. Parallel writers must use `isolated: true`; inspect or verify their patches before calling `apply(diff)`.
9. Add independent verification for consequential findings or edits. Do not ask the producer to certify itself.
10. Bound all retry and refinement loops explicitly.
11. End with integration or synthesis that reconciles conflicts, preserves evidence, checks completion criteria, and states uncertainty.
12. If useful parallelism does not exist, do not manufacture it: a workflow with two or three sequential specialist roles is valid.

## Decomposition choices

Choose the boundary that matches the task:

- **Semantic:** business capabilities or subsystems that can be understood coherently.
- **Dependency:** independent branches in a task graph.
- **Risk:** security, correctness, compatibility, performance, data integrity.
- **Perspective:** researcher, implementer, critic, verifier, user advocate.
- **Hypothesis:** competing explanations that benefit from independent investigation.
- **Artifact:** files or records only when they are genuinely independent.

## Pattern selection

- **Architect–specialists–integrator:** default for ambiguous or repository-wide work.
- **Adaptive investigation:** scout first, investigate only material questions, adjudicate conflicts, then synthesize.
- **Bounded map-reduce:** only for homogeneous and truly independent items.
- **Adversarial verification:** generate candidates, assign independent critics, then adjudicate disagreements.
- **Fix until green:** create an isolated patch, test it independently, and repeat with failure evidence for at most a fixed number of attempts.

For complete copyable examples, use the patterns below.
