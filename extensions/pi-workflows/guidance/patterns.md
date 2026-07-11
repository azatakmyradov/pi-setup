# Worked workflow patterns

## Architect, specialists, integrator (default)

```js
const architecture = await agent(`Analyze the objective and repository. Return coherent reasoning units, dependencies, risks, and completion checks. Do not return one unit per file. Return at most four units.`, {
  label: "architect",
  schema: {
    type: "object",
    required: ["units", "completionChecks"],
    properties: {
      units: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          required: ["id", "purpose", "context", "dependsOn"],
          properties: {
            id: { type: "string" },
            purpose: { type: "string" },
            context: { type: "array", items: { type: "string" } },
            dependsOn: { type: "array", items: { type: "string" } },
          },
        },
      },
      completionChecks: { type: "array", items: { type: "string" } },
    },
  },
})
const independent = architecture.units.filter((unit) => unit.dependsOn.length === 0).slice(0, 4)
const analyses = (await pipeline(independent, (unit) => agent(
  `Investigate this reasoning unit. Purpose: ${unit.purpose}\nRelevant context: ${unit.context.join(", ")}\nReturn compact evidence and recommendations.`,
  { label: unit.id },
))).filter(Boolean)
return await agent(`Integrate the architecture and specialist evidence. Resolve overlap and check every completion criterion.\nArchitecture: ${JSON.stringify(architecture)}\nEvidence: ${JSON.stringify(analyses)}`, {
  label: "integrate",
})
```

## Adaptive investigation

```js
const scout = await agent("Identify at most five material uncertainties whose answers could change the solution. Return JSON.", {
  label: "scout",
  schema: {
    type: "object",
    required: ["questions", "canAnswerDirectly"],
    properties: {
      canAnswerDirectly: { type: "boolean" },
      questions: { type: "array", maxItems: 5, items: { type: "string" } },
    },
  },
})
if (scout.canAnswerDirectly || scout.questions.length === 0) {
  return await agent(`Complete the objective using this scout result: ${JSON.stringify(scout)}`, { label: "complete" })
}
const investigations = (await pipeline(scout.questions.slice(0, 5), (question, index) => agent(
  `Investigate this material uncertainty independently. Return verdict, evidence, and confidence: ${question}`,
  { label: `question-${index + 1}` },
))).filter(Boolean)
return await agent(`Synthesize the investigations, call out conflicts, and answer the original objective: ${JSON.stringify(investigations)}`, {
  label: "synthesize",
})
```

## Bounded map-reduce for genuinely independent items

Use this only when each item is self-contained and does not require cross-item understanding. Batch items first when they share context.

```js
const discovered = await agent("Discover independent migration units and group coupled artifacts together. Return at most six units as JSON.", {
  schema: {
    type: "object",
    required: ["units"],
    properties: {
      units: { type: "array", maxItems: 6, items: { type: "object" } },
    },
  },
})
const findings = (await pipeline(discovered.units.slice(0, 6), (unit, index) => agent(
  `Handle this self-contained unit and return compact evidence: ${JSON.stringify(unit)}`,
  { label: `unit-${index + 1}`, lean: true },
))).filter(Boolean)
return await agent(`Integrate these unit results and check cross-unit consistency: ${JSON.stringify(findings)}`, {
  label: "integrate",
})
```

## Adversarial verification

```js
const candidates = (await pipeline(args.claims.slice(0, 6), (claim, index) => agent(
  `Investigate this claim independently. State verdict, evidence, and uncertainty: ${claim}`,
  { label: `investigate-${index + 1}` },
))).filter(Boolean)
const critiques = (await pipeline(candidates, (candidate, index) => agent(
  `Act as a skeptical verifier. Find unsupported assertions or contradictory evidence in:\n${candidate}`,
  { label: `verify-${index + 1}` },
))).filter(Boolean)
return await agent(`Adjudicate the investigations and independent critiques. Report only defensible conclusions and unresolved disputes.\nInvestigations: ${JSON.stringify(candidates)}\nCritiques: ${JSON.stringify(critiques)}`)
```

## Bounded fix-until-green

```js
let failure = args.failure
for (let attempt = 1; attempt <= 3; attempt++) {
  const change = await agent(`Fix this failure in the smallest safe coherent patch. Run focused tests. Failure:\n${failure}`, {
    label: `fix-${attempt}`,
    isolated: true,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  })
  const verdict = await agent(`Review this patch and test evidence independently. Reply JSON with approved and reason.\n${change.diff}\n${change.output}`, {
    label: `verify-${attempt}`,
    schema: { type: "object", required: ["approved", "reason"], properties: { approved: { type: "boolean" }, reason: { type: "string" } } },
  })
  if (verdict.approved) {
    await apply(change.diff)
    return `Applied verified patch on attempt ${attempt}: ${verdict.reason}`
  }
  failure = verdict.reason
}
return "No verified patch was produced after 3 attempts."
```
