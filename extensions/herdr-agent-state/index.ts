import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import managedHerdrIntegration from "../herdr-agent-state.ts";
import { withSettledAgentLifecycle } from "./settled-lifecycle.ts";

export default function herdrAgentState(pi: ExtensionAPI): void {
  managedHerdrIntegration(withSettledAgentLifecycle(pi));
}
