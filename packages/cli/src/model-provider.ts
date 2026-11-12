/**
 * The real model provider for a resolved config — the one place the CLI builds
 * one. Every construction site (the agent, the sub-agents' per-type models, the
 * laptop side of the pod reverse-tunnel) calls this, so each gets the same
 * connection retry AND logs each retried drop to the daemon log: a recovered
 * blip shows nothing on screen, and this line is its only trace.
 */
import type { AgentType, SubagentModel } from "@tentacle/agent";
import { type PublishedModels, type TentacleConfig, pickSubagentModel } from "@tentacle/config";
import type { ModelProvider } from "@tentacle/core";
import { type CreateModelProviderOptions, createModelProvider } from "@tentacle/providers";
import { logModelRetry } from "./daemon-log.ts";

/** How a provider is built; tests inject a spy (`BuildAgentOptions.createProvider`). */
export type ProviderFactory = (options: CreateModelProviderOptions) => ModelProvider;

/** The providers of one agent's sub-agents (docs/feat/models-map.md), lazily, once each. */
export interface ModelProviders {
  /** A `models` entry's provider: ITS endpoint and key only (never the main key). */
  forEntry(name: string): ModelProvider;
  /** An `agents/*.md` model id that is no `models` name: the MAIN endpoint and key. */
  forId(modelId: string): ModelProvider;
}

export function createModelProviders(
  config: Pick<
    TentacleConfig,
    | "provider"
    | "baseURL"
    | "apiKey"
    | "maxTokens"
    | "maxImageBytes"
    | "images"
    | "configDir"
    | "models"
  >,
  create: ProviderFactory = createModelProvider,
): ModelProviders {
  const onRetry = (info: Parameters<typeof logModelRetry>[1]) =>
    logModelRetry(config.configDir, info);
  const entries = new Map<string, ModelProvider>();
  const ids = new Map<string, ModelProvider>();
  return {
    forEntry(name) {
      const cached = entries.get(name);
      if (cached) {
        return cached;
      }
      const entry = Object.hasOwn(config.models, name) ? config.models[name] : undefined;
      if (!entry) {
        throw new Error(`no models entry ${JSON.stringify(name)}`);
      }
      const made = create({
        provider: entry.provider,
        baseURL: entry.baseURL,
        model: entry.model,
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
        ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxImageBytes !== undefined ? { maxImageBytes: entry.maxImageBytes } : {}),
        ...(entry.images !== undefined ? { images: entry.images } : {}),
        onRetry,
      });
      entries.set(name, made);
      return made;
    },
    forId(modelId) {
      const cached = ids.get(modelId);
      if (cached) {
        return cached;
      }
      const made = create({
        provider: config.provider,
        baseURL: config.baseURL,
        model: modelId,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.maxImageBytes !== undefined ? { maxImageBytes: config.maxImageBytes } : {}),
        ...(config.images !== undefined ? { images: config.images } : {}),
        onRetry,
      });
      ids.set(modelId, made);
      return made;
    },
  };
}

/** `SubagentDeps.modelFor` for this config: `pickSubagentModel`, mapped to providers. */
export function subagentModelResolver(
  config: Pick<TentacleConfig, "model" | "models" | "subagentModels" | "selectableModels">,
  providers: ModelProviders,
): (type: AgentType, requested: string | undefined) => SubagentModel | undefined {
  return (type, requested) => {
    const choice = pickSubagentModel(
      {
        requested,
        typeName: type.name,
        frontmatterModel: type.model,
        frontmatterWindow: type.contextWindow,
      },
      config,
    );
    switch (choice.kind) {
      case "default":
        return undefined;
      case "id":
        // A bare id is not a `models` NAME (AGENTS §7): it never reaches a row.
        return {
          provider: providers.forId(choice.id),
          modelId: choice.id,
          ...(choice.contextWindow !== undefined ? { contextWindow: choice.contextWindow } : {}),
        };
      case "entry": {
        // The NAME is what the panel may show, and the ID is what "differs from
        // the main agent" is decided against — by the DAEMON, on every publish
        // (docs/feat/subagent-panel.md, Review round 3 M2: a `/model` under a
        // running child re-decides it). Here both facts are reported as they
        // are; nothing is frozen. The wire carries a `models` NAME, never an id
        // (AGENTS §7).
        const entry = config.models[choice.name];
        return {
          provider: providers.forEntry(choice.name),
          contextWindow: choice.contextWindow,
          modelId: entry?.model ?? choice.name,
          name: choice.name,
        };
      }
    }
  };
}

/**
 * `SubagentDeps.modelFor` over the pod tunnel (docs/feat/models-map-pod.md): the
 * same pick, on what the laptop published, without the pod's frontmatter
 * `model` (unlike a local run). Only an entry gets a name on the wire: a
 * frontmatter model is never sent, the child stays on the main tunnel.
 * `modelId` is the NAME, so hooks in a pod do not learn the laptop's id.
 */
export function tunnelSubagentResolver(
  published: PublishedModels,
  tunnel: (name: string) => ModelProvider,
): (type: AgentType, requested: string | undefined) => SubagentModel | undefined {
  const models = Object.fromEntries(published.models.map((m) => [m.name, m]));
  const subagentModels = Object.fromEntries(published.types.map((t) => [t.type, t.model]));
  return (type, requested) => {
    const choice = pickSubagentModel(
      // No `frontmatterModel`: a pod's own agents/*.md never picks a laptop
      // entry; only the laptop's `subagents.types` and the agent's selectable
      // call do (owner Q3 (b)). With no entry the type's own window applies.
      { requested, typeName: type.name, frontmatterWindow: type.contextWindow },
      { models, subagentModels, selectableModels: published.selectable },
    );
    return choice.kind === "entry"
      ? {
          provider: tunnel(choice.name),
          contextWindow: choice.contextWindow,
          modelId: choice.name,
          // Over the tunnel the main model IS the tunnel: any named entry is a
          // different model, so it is named (and it is a name, never an id).
          name: choice.name,
        }
      : undefined;
  };
}

export function configuredModelProvider(
  config: Pick<
    TentacleConfig,
    | "provider"
    | "baseURL"
    | "model"
    | "apiKey"
    | "maxTokens"
    | "maxImageBytes"
    | "images"
    | "configDir"
  >,
  /** A model id on the same endpoint (the title model); defaults to `config.model`. */
  model: string = config.model,
  create: ProviderFactory = createModelProvider,
): ModelProvider {
  return create({
    provider: config.provider,
    baseURL: config.baseURL,
    model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.maxImageBytes !== undefined ? { maxImageBytes: config.maxImageBytes } : {}),
    ...(config.images !== undefined ? { images: config.images } : {}),
    onRetry: (info) => logModelRetry(config.configDir, info),
  });
}
