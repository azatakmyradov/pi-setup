import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type RuntimeHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RuntimeOn = (event: string, handler: RuntimeHandler) => void;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => unknown;

const emptyAgentEndEvent: AgentEndEvent = {
  type: "agent_end",
  messages: [],
};

/**
 * Adapts integrations written for the old agent_end lifecycle so they only
 * observe completion after Pi has exhausted retries, compaction, and queued
 * continuations.
 */
export function withSettledAgentLifecycle(pi: ExtensionAPI): ExtensionAPI {
  const register = pi.on.bind(pi) as unknown as RuntimeOn;

  const on = ((eventName: string, handler: RuntimeHandler) => {
    if (eventName !== "agent_end") {
      register(eventName, handler);
      return;
    }

    const agentEndHandler = handler as AgentEndHandler;
    let latestAgentEnd: AgentEndEvent | undefined;

    register("agent_end", (event) => {
      latestAgentEnd = event as AgentEndEvent;
    });

    register("agent_settled", (_event, ctx) => {
      const event = latestAgentEnd ?? emptyAgentEndEvent;
      latestAgentEnd = undefined;
      return agentEndHandler(event, ctx);
    });
  }) as ExtensionAPI["on"];

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "on") {
        return on;
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
