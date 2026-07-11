export const WORKFLOW_MENTION_SOURCE = String.raw`(?<![\w@/.-])workflows\b(?![-/])`;
const WORKFLOW_MENTION = new RegExp(WORKFLOW_MENTION_SOURCE, "i");

export function mentionsWorkflow(message: string): boolean {
	return WORKFLOW_MENTION.test(message);
}
