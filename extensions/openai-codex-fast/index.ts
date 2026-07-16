import {
  type ExtensionAPI,
  type ModelChangeEntry,
  type ModelRegistry,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getModels,
  isContextOverflow,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const OPENAI_CODEX_FAST_API = "openai-codex-fast-responses";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_FAST_PROVIDER = "openai-codex-fast";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PLACEHOLDER_API_KEY = "__openai_codex_fast_reuses_openai_codex_auth__";
const OPENAI_CODEX_FAST_MODEL_IDS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

type ExtensionDiagnostic = {
  type: "warning" | "error";
  code: "auth-failed" | "missing-openai-codex-auth" | "no-fast-models" | "no-model-base-url";
  message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; diagnostic: ExtensionDiagnostic };
type OpenAICodexApi = typeof OPENAI_CODEX_API;
type OpenAICodexModel = Model<OpenAICodexApi>;
type ModelRegistryAccess = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;
type RequestAuth = { apiKey: string; headers?: Record<string, string> };

const { readStoredCredential } = PiCodingAgent as typeof PiCodingAgent & {
  readStoredCredential(provider: string): unknown;
};

function authFailedDiagnostic(reason: string): ExtensionDiagnostic {
  return {
    type: "error",
    code: "auth-failed",
    message: `${OPENAI_CODEX_PROVIDER} auth failed: ${reason}`,
  };
}

async function getOpenAICodexAuth(): Promise<Result<string>> {
  try {
    const credential = readStoredCredential(OPENAI_CODEX_PROVIDER);
    if (credential) return { ok: true, value: PLACEHOLDER_API_KEY };

    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "missing-openai-codex-auth",
        message: `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: authFailedDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function getOpenAICodexRequestAuth(
  modelRegistry: ModelRegistryAccess | undefined,
  model: OpenAICodexModel,
): Promise<Result<RequestAuth>> {
  if (!modelRegistry) {
    return {
      ok: false,
      diagnostic: authFailedDiagnostic("model registry is not available"),
    };
  }

  try {
    const resolved = await modelRegistry.getApiKeyAndHeaders(model);
    if (!resolved.ok) {
      return { ok: false, diagnostic: authFailedDiagnostic(resolved.error) };
    }
    if (!resolved.apiKey) {
      return {
        ok: false,
        diagnostic: {
          type: "error",
          code: "missing-openai-codex-auth",
          message: `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
        },
      };
    }
    return {
      ok: true,
      value: {
        apiKey: resolved.apiKey,
        ...(resolved.headers ? { headers: resolved.headers } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: authFailedDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

function getEffectiveOpenAICodexModels(
  modelRegistry: Pick<ModelRegistry, "find">,
  catalogModels: readonly OpenAICodexModel[],
): OpenAICodexModel[] {
  const effectiveModels: OpenAICodexModel[] = [];
  for (const catalogModel of catalogModels) {
    const effectiveModel = modelRegistry.find(OPENAI_CODEX_PROVIDER, catalogModel.id);
    if (effectiveModel?.api === OPENAI_CODEX_API) {
      effectiveModels.push(effectiveModel as OpenAICodexModel);
    }
  }
  return effectiveModels;
}

function getOpenAICodexFastModels(
  openAICodexModels: readonly OpenAICodexModel[],
): ProviderModelConfig[] {
  return openAICodexModels
    .filter((model) => OPENAI_CODEX_FAST_MODEL_IDS.has(model.id))
    .map(
      (model): ProviderModelConfig => ({
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: model.thinkingLevelMap }
          : {}),
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.headers !== undefined ? { headers: model.headers } : {}),
        ...(model.compat !== undefined ? { compat: model.compat } : {}),
      }),
    );
}

function getFastProviderBaseUrl(
  openAICodexFastModels: readonly ProviderModelConfig[],
): Result<string> {
  if (openAICodexFastModels.length === 0) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-fast-models",
        message: `No models available for ${OPENAI_CODEX_FAST_PROVIDER}. The provider will not be registered.`,
      },
    };
  }

  const baseUrl = openAICodexFastModels.find((model) => model.baseUrl)?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-model-base-url",
        message: `No base URL found for any ${OPENAI_CODEX_FAST_PROVIDER} model. The provider will not be registered.`,
      },
    };
  }

  return { ok: true, value: baseUrl };
}

function endWithCanonicalError(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  modelId: string,
  errorMessage: string,
  options?: SimpleStreamOptions,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options?.signal?.aborted ? "aborted" : "error",
    errorMessage,
    timestamp: Date.now(),
  };
  stream.push({
    type: "error",
    reason: message.stopReason === "aborted" ? "aborted" : "error",
    error: message,
  });
  stream.end(message);
}

function streamSimpleOpenAICodexFast(
  getModelRegistry: () => ModelRegistryAccess | undefined,
  openAICodexModels: readonly OpenAICodexModel[],
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    try {
      const codexModel = openAICodexModels.find((m) => m.id === model.id);
      if (!codexModel) {
        endWithCanonicalError(
          outer,
          model.id,
          `Underlying ${OPENAI_CODEX_PROVIDER} model not found for ${model.id}.`,
          options,
        );
        return;
      }

      const auth = await getOpenAICodexRequestAuth(
        getModelRegistry(),
        codexModel,
      );
      if (!auth.ok) {
        endWithCanonicalError(outer, model.id, auth.diagnostic.message, options);
        return;
      }

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(codexModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const inner = streamOpenAICodexResponses(codexModel, context, {
        ...options,
        apiKey: auth.value.apiKey,
        serviceTier: "priority",
        ...(auth.value.headers
          ? { headers: { ...options?.headers, ...auth.value.headers } }
          : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      for await (const event of inner) {
        if (event.type === "error" && isContextOverflow(event.error, codexModel.contextWindow)) {
          outer.push({
            ...event,
            error: {
              ...event.error,
              provider: OPENAI_CODEX_FAST_PROVIDER,
              model: model.id,
            },
          });
        } else {
          outer.push(event);
        }
      }
      outer.end();
    } catch (error) {
      endWithCanonicalError(
        outer,
        model.id,
        error instanceof Error ? error.message : String(error),
        options,
      );
    }
  })();

  return outer;
}

export default async function (pi: ExtensionAPI) {
  const catalogOpenAICodexModels = getModels(OPENAI_CODEX_PROVIDER);
  let openAICodexModels = catalogOpenAICodexModels;
  let activeModelRegistry: ModelRegistryAccess | undefined;
  const diagnostics: ExtensionDiagnostic[] = [];
  let providerRegistered = false;
  let registeredModelSignature: string | undefined;

  function applyFastProvider(openAICodexFastModels: ProviderModelConfig[], baseUrl: string): void {
    pi.registerProvider(OPENAI_CODEX_FAST_PROVIDER, {
      name: "OpenAI Codex Fast",
      baseUrl,
      apiKey: PLACEHOLDER_API_KEY,
      api: OPENAI_CODEX_FAST_API,
      models: openAICodexFastModels,
      streamSimple: (model, context, options) =>
        streamSimpleOpenAICodexFast(
          () => activeModelRegistry,
          openAICodexModels,
          model,
          context,
          options,
        ),
    });
    registeredModelSignature = JSON.stringify(openAICodexFastModels);
    providerRegistered = true;
  }

  function refreshEffectiveModels(modelRegistry: ModelRegistryAccess): boolean {
    activeModelRegistry = modelRegistry;
    openAICodexModels = getEffectiveOpenAICodexModels(
      modelRegistry,
      catalogOpenAICodexModels,
    );
    if (!providerRegistered) return false;

    const fastModels = getOpenAICodexFastModels(openAICodexModels);
    const signature = JSON.stringify(fastModels);
    if (signature === registeredModelSignature) return false;

    if (fastModels.length === 0) {
      pi.unregisterProvider(OPENAI_CODEX_FAST_PROVIDER);
      providerRegistered = false;
      registeredModelSignature = undefined;
      diagnostics.push({
        type: "error",
        code: "no-fast-models",
        message: `No compatible models available for ${OPENAI_CODEX_FAST_PROVIDER}. The provider was removed.`,
      });
      return true;
    }

    const baseUrl = getFastProviderBaseUrl(fastModels);
    if (!baseUrl.ok) {
      diagnostics.push(baseUrl.diagnostic);
      return false;
    }

    applyFastProvider(fastModels, baseUrl.value);
    return true;
  }

  async function registerFastProviderIfReady(): Promise<void> {
    if (providerRegistered) {
      return;
    }

    const auth = await getOpenAICodexAuth();
    if (!auth.ok) {
      diagnostics.push(auth.diagnostic);
    }

    const fastModels = getOpenAICodexFastModels(openAICodexModels);
    const baseUrl = getFastProviderBaseUrl(fastModels);
    if (!baseUrl.ok) {
      diagnostics.push(baseUrl.diagnostic);
    }

    if (!auth.ok || !baseUrl.ok) {
      return;
    }

    applyFastProvider(fastModels, baseUrl.value);
  }

  pi.on("model_select", async (event, ctx) => {
    const refreshed = refreshEffectiveModels(ctx.modelRegistry);
    if (!refreshed || event.model.provider !== OPENAI_CODEX_FAST_PROVIDER) return;

    const currentModel = ctx.model;
    if (
      currentModel?.provider === OPENAI_CODEX_FAST_PROVIDER &&
      currentModel.id === event.model.id &&
      currentModel !== event.model
    ) {
      return;
    }

    const refreshedModel = ctx.modelRegistry.find(OPENAI_CODEX_FAST_PROVIDER, event.model.id);
    if (refreshedModel && refreshedModel !== currentModel) {
      await pi.setModel(refreshedModel);
      return;
    }

    if (!refreshedModel) {
      const canonicalModel = ctx.modelRegistry.find(OPENAI_CODEX_PROVIDER, event.model.id);
      if (canonicalModel && canonicalModel !== currentModel) {
        await pi.setModel(canonicalModel);
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const refreshed = refreshEffectiveModels(ctx.modelRegistry);
    if (refreshed && ctx.model?.provider === OPENAI_CODEX_FAST_PROVIDER) {
      const refreshedModel = ctx.modelRegistry.find(OPENAI_CODEX_FAST_PROVIDER, ctx.model.id);
      if (refreshedModel && refreshedModel !== ctx.model) {
        await pi.setModel(refreshedModel);
      } else if (!refreshedModel) {
        const canonicalModel = ctx.modelRegistry.find(OPENAI_CODEX_PROVIDER, ctx.model.id);
        if (canonicalModel && canonicalModel !== ctx.model) {
          await pi.setModel(canonicalModel);
        }
      }
    }

    if (!providerRegistered && diagnostics.length === 0) {
      await registerFastProviderIfReady();
    }
    for (const diagnostic of diagnostics.splice(0)) {
      if (ctx.hasUI) {
        ctx.ui.notify(diagnostic.message, diagnostic.type);
      } else if (diagnostic.type === "error") {
        console.error(`[${OPENAI_CODEX_FAST_PROVIDER}] ${diagnostic.message}`);
      } else {
        console.warn(`[${OPENAI_CODEX_FAST_PROVIDER}] ${diagnostic.message}`);
      }
    }
    if (!providerRegistered) {
      return;
    }

    let latestModelChange: ModelChangeEntry | undefined;
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type === "model_change") {
        latestModelChange = entry;
        break;
      }
    }

    if (latestModelChange?.provider !== OPENAI_CODEX_FAST_PROVIDER) {
      return;
    }

    const { modelId } = latestModelChange;
    if (ctx.model?.provider === OPENAI_CODEX_FAST_PROVIDER && ctx.model.id === modelId) {
      return;
    }

    const fastModel = ctx.modelRegistry.find(OPENAI_CODEX_FAST_PROVIDER, modelId);
    if (fastModel) {
      await pi.setModel(fastModel);
    }
  });

  await registerFastProviderIfReady();
}
