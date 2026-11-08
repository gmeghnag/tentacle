/**
 * The `models` map (docs/feat/models-map.md): named models for sub-agents.
 * Pure — no I/O; `load.ts` runs the entries' key commands.
 *
 *  - `modelRefIssues`: every `models` name `subagents.*` uses exists, in the
 *    base and in each profile's merged view (called by the file schema).
 *  - `resolveModelEntry`: an entry over the main model's EFFECTIVE values
 *    (owner Q2). The connection group moves as a unit, as in a profile: an
 *    entry that sets any connection key inherits none of them, so the main
 *    key is never sent to another endpoint.
 *  - `pickSubagentModel`: which model a sub-agent runs on — the call's `model`
 *    (when selectable) › `subagents.types.<t>.model` › the `agents/*.md`
 *    `model` (a `models` name, else a model id) › the main model.
 */
import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_BASE_URL, DEFAULT_PROVIDER } from "./defaults.ts";
import { CONNECTION_KEYS, applyProfile } from "./profile.ts";
import type { FileConfig, ModelEntryConfig } from "./schema.ts";

/** The main model's effective values, as `resolveConfig` resolved them. */
export interface MainModel {
  readonly provider: "openai" | "anthropic";
  readonly baseURL: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens?: number;
  /** The main key when known without a command (env or file); a command's is filled in by load. */
  readonly apiKey?: string;
}

/** A `models` entry, resolved. Holds the key in memory only: never printed, never carried. */
export interface ResolvedModel {
  readonly provider: "openai" | "anthropic";
  readonly baseURL: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens?: number;
  readonly description?: string;
  /** Where the key comes from — never the key. `inherited` = the main model's (same endpoint). */
  readonly apiKeySource: "inherited" | "file" | "command" | "none";
  /** The entry's OWN command (never inherited): run by load, hidden from a workspace mount. */
  readonly apiKeyCommand?: string;
  /** The key: its own literal, or (after load) its command's output or the inherited main key. */
  readonly apiKey?: string;
}

/** Which model a sub-agent runs on. `default` = the parent's model, as before. */
export type ModelChoice =
  | { readonly kind: "default" }
  | { readonly kind: "entry"; readonly name: string; readonly contextWindow: number }
  | { readonly kind: "id"; readonly id: string; readonly contextWindow?: number };

const has = (map: Readonly<Record<string, unknown>> | undefined, key: string): boolean =>
  map !== undefined && Object.hasOwn(map, key);

/** An entry over the main model (rules in the module comment). */
export function resolveModelEntry(main: MainModel, entry: ModelEntryConfig): ResolvedModel {
  const ownsConnection = CONNECTION_KEYS.some((key) => entry[key] !== undefined);
  const maxTokens = entry.maxTokens ?? main.maxTokens;
  const rest = {
    model: entry.model ?? main.model,
    contextWindow: entry.contextWindow ?? main.contextWindow,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  };
  if (!ownsConnection) {
    return {
      provider: main.provider,
      baseURL: main.baseURL,
      ...rest,
      apiKeySource: "inherited",
      ...(main.apiKey !== undefined ? { apiKey: main.apiKey } : {}),
    };
  }
  const provider = entry.provider ?? DEFAULT_PROVIDER;
  const baseURL =
    entry.baseURL ?? (provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL);
  if (entry.apiKey !== undefined) {
    return { provider, baseURL, ...rest, apiKeySource: "file", apiKey: entry.apiKey };
  }
  if (entry.apiKeyCommand !== undefined) {
    return {
      provider,
      baseURL,
      ...rest,
      apiKeySource: "command",
      apiKeyCommand: entry.apiKeyCommand,
    };
  }
  return { provider, baseURL, ...rest, apiKeySource: "none" };
}

/** The part of a config view the reference check reads. */
interface RefView {
  readonly models?: Readonly<Record<string, unknown>> | undefined;
  readonly subagents?:
    | {
        readonly types?: Readonly<Record<string, { readonly model?: string | undefined }>>;
        readonly selectableModels?: readonly string[] | undefined;
      }
    | undefined;
}

function viewIssues(view: RefView): string[] {
  const names = Object.keys(view.models ?? {}).sort();
  const defined = names.length > 0 ? `defined: ${names.join(", ")}` : "no models defined";
  const issues: string[] = [];
  for (const [type, block] of Object.entries(view.subagents?.types ?? {})) {
    if (block.model !== undefined && !has(view.models, block.model)) {
      issues.push(
        `subagents.types.${type}.model: ${JSON.stringify(block.model)} is not a models entry (${defined})`,
      );
    }
  }
  for (const name of view.subagents?.selectableModels ?? []) {
    if (!has(view.models, name)) {
      issues.push(
        `subagents.selectableModels: ${JSON.stringify(name)} is not a models entry (${defined})`,
      );
    }
  }
  return issues;
}

/**
 * Every `models` name `subagents.*` uses that does not exist: the base view's
 * issues as they are, then each profile's NEW ones, prefixed `profiles.<p>: `.
 */
export function modelRefIssues(file: FileConfig): string[] {
  const base = applyProfile(file, undefined);
  const baseIssues = base.ok ? viewIssues(base.config) : [];
  const out = [...baseIssues];
  for (const name of Object.keys(file.profiles ?? {})) {
    const applied = applyProfile(file, name);
    if (!applied.ok) {
      continue;
    }
    for (const issue of viewIssues(applied.config)) {
      if (!baseIssues.includes(issue)) {
        out.push(`profiles.${name}: ${issue}`);
      }
    }
  }
  return out;
}

/** The pick (precedence in the module comment); `Object.hasOwn` for every lookup. */
export function pickSubagentModel(
  input: {
    /** The call's `model`; used only when listed in `selectableModels`. */
    readonly requested?: string | undefined;
    readonly typeName: string;
    /** The type's `agents/*.md` `model`. */
    readonly frontmatterModel?: string | undefined;
    /** The type's `agents/*.md` `contextWindow`. */
    readonly frontmatterWindow?: number | undefined;
  },
  config: {
    /** Only the window is read: a pod has no more than that (`PublishedModels`). */
    readonly models: Readonly<Record<string, Pick<ResolvedModel, "contextWindow">>>;
    readonly subagentModels: Readonly<Record<string, string>>;
    readonly selectableModels: readonly string[];
  },
): ModelChoice {
  const entry = (name: string): Pick<ResolvedModel, "contextWindow"> | undefined =>
    has(config.models, name) ? config.models[name] : undefined;
  const { requested, typeName, frontmatterModel, frontmatterWindow } = input;
  if (requested !== undefined && config.selectableModels.includes(requested)) {
    const chosen = entry(requested);
    if (chosen) {
      return { kind: "entry", name: requested, contextWindow: chosen.contextWindow };
    }
  }
  const typeModel = has(config.subagentModels, typeName)
    ? config.subagentModels[typeName]
    : undefined;
  if (typeModel !== undefined) {
    const chosen = entry(typeModel);
    if (chosen) {
      // The frontmatter window describes the frontmatter's model: not this one.
      return { kind: "entry", name: typeModel, contextWindow: chosen.contextWindow };
    }
  }
  if (frontmatterModel !== undefined) {
    const chosen = entry(frontmatterModel);
    if (chosen) {
      return {
        kind: "entry",
        name: frontmatterModel,
        contextWindow: frontmatterWindow ?? chosen.contextWindow,
      };
    }
    return {
      kind: "id",
      id: frontmatterModel,
      ...(frontmatterWindow !== undefined ? { contextWindow: frontmatterWindow } : {}),
    };
  }
  return { kind: "default" };
}

/**
 * What a laptop publishes to a pod (docs/feat/models-map-pod.md): names and
 * numbers, never a model id, a URL or a key. Structurally the wire's
 * `PublishedModels`; this package does not depend on the protocol.
 */
export interface PublishedModels {
  readonly models: {
    readonly name: string;
    readonly contextWindow: number;
    readonly description?: string | undefined;
  }[];
  readonly types: { readonly type: string; readonly model: string }[];
  readonly selectable: string[];
}

interface ModelsView {
  readonly models: Readonly<Record<string, ResolvedModel>>;
  readonly subagentModels: Readonly<Record<string, string>>;
  readonly selectableModels: readonly string[];
}

/**
 * THE allowlist: the names a pod may ask this laptop for — the entries
 * `subagents.types` and `subagents.selectableModels` use, sorted. The laptop's
 * own config is its only input: what a pod says never widens it (AGENTS §7).
 */
export function publishedModelNames(config: ModelsView): string[] {
  const used = [...Object.values(config.subagentModels), ...config.selectableModels];
  return [...new Set(used)].filter((name) => has(config.models, name)).sort();
}

/** What travels (`undefined`: nothing). Sorted, so equal configs give equal JSON. */
export function publishedModels(config: ModelsView): PublishedModels | undefined {
  const names = publishedModelNames(config);
  if (names.length === 0) {
    return undefined;
  }
  const published = new Set(names);
  const selectable = [...new Set(config.selectableModels)].filter((name) => published.has(name));
  return {
    models: names.map((name) => {
      const contextWindow = config.models[name]?.contextWindow ?? 0;
      const description = selectable.includes(name) ? config.models[name]?.description : undefined;
      return { name, contextWindow, ...(description !== undefined ? { description } : {}) };
    }),
    types: Object.entries(config.subagentModels)
      .filter(([, model]) => published.has(model))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([type, model]) => ({ type, model })),
    selectable,
  };
}

/** A configured type that no built-in or `agents/*.md` defines: its model is unused. */
export function unknownTypeModelWarnings(
  subagentModels: Readonly<Record<string, string>>,
  knownTypes: readonly string[],
): string[] {
  return Object.keys(subagentModels)
    .filter((type) => !knownTypes.includes(type))
    .map(
      (type) =>
        `subagents.types.${type}: no sub-agent type ${JSON.stringify(type)} (known: ${knownTypes.join(", ")}) — its model is not used`,
    );
}
