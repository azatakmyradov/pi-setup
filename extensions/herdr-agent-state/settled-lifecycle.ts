import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";

/** The registration signature every `ExtensionAPI["on"]` overload shares once its event name is erased. */
type LifecycleHandler = (event: ExtensionEvent, ctx: ExtensionContext) => Promise<void> | void;
type LifecycleRegister = (eventName: string, handler: LifecycleHandler) => void;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;

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
  // SAFETY: every `ExtensionAPI["on"]` overload pairs a string event name with a
  // handler for that event, so the bound method accepts the name/handler pairs
  // this wrapper forwards; the only per-event difference is the event type, and
  // `ExtensionEvent` is the union of all of them.
  const register = pi.on.bind(pi) as LifecycleRegister;

  // SAFETY: the wrapper below forwards each (event name, handler) pair straight to
  // `pi.on`, so it honours every overload of `ExtensionAPI["on"]` it stands in for.
  const on = ((eventName: string, handler: LifecycleHandler) => {
    if (eventName !== "agent_end") {
      register(eventName, handler);
      return;
    }

    // SAFETY: this branch only runs for `on("agent_end", handler)`, whose sole
    // overload requires an agent_end handler.
    const agentEndHandler = handler as AgentEndHandler;
    let latestAgentEnd: AgentEndEvent | undefined;

    register("agent_end", (event) => {
      if (event.type === "agent_end") {
        latestAgentEnd = event;
      }
    });

    register("agent_settled", (_event, ctx) => {
      const event = latestAgentEnd ?? emptyAgentEndEvent;
      latestAgentEnd = undefined;
      return agentEndHandler(event, ctx);
    });
  }) as ExtensionAPI["on"];

  const adapted: ExtensionAPI = Object.create(pi);
  adapted.on = on;
  return adapted;
}
