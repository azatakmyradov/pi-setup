import { CustomEditor } from "@earendil-works/pi-coding-agent";

import { mentionsWorkflow, WORKFLOW_MENTION_SOURCE } from "./eligibility.ts";

const ANIMATED_TRIGGER_GLOBAL = new RegExp(`${WORKFLOW_MENTION_SOURCE}|(?<![\\w@/.-])claude\\b(?![-/])`, "gi");

const COLORS: [number, number, number][] = [
	[102, 194, 179],
	[121, 157, 207],
	[157, 134, 195],
	[206, 130, 172],
];
const RESET = "\x1b[0m";

function foreground([r, g, b]: [number, number, number], brightness: number): string {
	const brighten = (channel: number) => Math.round(channel + (255 - channel) * brightness);
	return `\x1b[38;2;${brighten(r)};${brighten(g)};${brighten(b)}m`;
}

function animateWord(word: string, shinePosition: number): string {
	return (
		[...word]
			.map((character, index) => {
				const distance = Math.abs(index - shinePosition);
				const brightness = distance === 0 ? 0.75 : distance === 1 ? 0.35 : 0;
				return `${foreground(COLORS[index % COLORS.length]!, brightness)}${character}`;
			})
			.join("") + RESET
	);
}

export class WorkflowEditor extends CustomEditor {
	private animationTimer?: ReturnType<typeof setInterval>;
	private frame = 0;

	private hasAnimatedTrigger(): boolean {
		const text = this.getText();
		ANIMATED_TRIGGER_GLOBAL.lastIndex = 0;
		return mentionsWorkflow(text) || ANIMATED_TRIGGER_GLOBAL.test(text);
	}

	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationTimer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 70);
	}

	private stopAnimation(): void {
		if (!this.animationTimer) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	dispose(): void {
		this.stopAnimation();
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		if (this.hasAnimatedTrigger()) this.startAnimation();
		else this.stopAnimation();
	}

	override render(width: number): string[] {
		const cycle = this.frame % 24;
		const shinePosition = cycle < 12 ? cycle - 1 : -10;
		ANIMATED_TRIGGER_GLOBAL.lastIndex = 0;
		return super.render(width).map((line) =>
			line.replace(ANIMATED_TRIGGER_GLOBAL, (word) => animateWord(word, shinePosition)),
		);
	}
}
