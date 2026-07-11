export const meta = {
  name: "deep-research",
  description: "Research a question in parallel, verify claims, and synthesize a sourced report",
}

const input = typeof args === "string" ? { question: args } : (args ?? {})
const question = typeof input.question === "string" ? input.question.trim() : ""
if (!question) throw new Error('Usage: /deep-research "question" or /deep-research {"question":"...","breadth":6}')
const requestedBreadth = Number.isFinite(Number(input.breadth)) ? Number(input.breadth) : 5
const breadth = Math.max(2, Math.min(10, Math.floor(requestedBreadth)))

const plan = await agent(`Create ${breadth} distinct research angles for the question below. Cover primary sources, counterarguments, and current evidence. Return JSON only.\n\nQuestion: ${question}`, {
  label: "research-plan",
  tools: ["websearch", "webfetch"],
  schema: {
    type: "object",
    required: ["angles"],
    properties: {
      angles: {
        type: "array",
        maxItems: 10,
        items: { type: "string" },
      },
    },
  },
})

log(`researching ${plan.angles.slice(0, breadth).length} angles`)
const investigations = (await pipeline(plan.angles.slice(0, breadth), (angle, index) => agent(
  `Research this angle for the question below using websearch and webfetch. Prefer primary and recent sources. Return a compact report containing claims, supporting URLs, publication dates when relevant, contradictory evidence, and uncertainty. Do not invent citations.\n\nQuestion: ${question}\nAngle: ${angle}`,
  { label: `research-${index + 1}`, tools: ["websearch", "webfetch"] },
))).filter(Boolean)

if (!investigations.length) throw new Error("Research produced no results. Ensure the web-tools extension provides websearch and webfetch.")

const verification = await agent(`Independently challenge the research below. Use websearch and webfetch to check important claims and URLs. Identify unsupported claims, source conflicts, stale evidence, and corrections. Preserve verified URLs.\n\nQuestion: ${question}\nResearch: ${JSON.stringify(investigations)}`, {
  label: "adversarial-verification",
  tools: ["websearch", "webfetch"],
})

return await agent(`Write a self-contained answer to the research question from the investigations and independent verification below. Reconcile conflicts; do not repeat unsupported claims. Include: concise answer, key findings, disagreements/limitations, and a deduplicated Sources section with descriptive titles and URLs. Clearly state uncertainty.\n\nQuestion: ${question}\nInvestigations: ${JSON.stringify(investigations)}\nVerification: ${verification}`, {
  label: "final-synthesis",
  tools: ["websearch", "webfetch"],
})
