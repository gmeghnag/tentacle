/**
 * Pure profile merge (docs/feat/config-profiles.md): fold the named profile of
 * the user's own config file over its base settings. No I/O; `load.ts` turns a
 * failure into a `ConfigError`.
 *
 * Rules: a top-level setting in the profile wins; `subagents`/`tools`/
 * `contextAwareness` merge per key; `model` merges per key EXCEPT the connection group (provider, baseURL,
 * apiKey, apiKeyCommand), which moves as a unit, so a key is never sent to an
 * endpoint it was not configured for; `mcpServers` merge by name (a definition
 * is replaced whole, `null` removes it). The result never carries `profiles`.
 */
import type { FileConfig, McpServerConfig, ModelConfig } from "./schema.ts";

export type ProfileResult =
  | { readonly ok: true; readonly config: FileConfig }
  | { readonly ok: false; readonly reason: string };

/** The `model` keys that identify an endpoint and its credentials. */
const CONNECTION_KEYS = ["provider", "baseURL", "apiKey", "apiKeyCommand"] as const;

function mergeModel(base: ModelConfig | undefined, over: ModelConfig): ModelConfig {
  const merged: ModelConfig = { ...base };
  if (CONNECTION_KEYS.some((key) => over[key] !== undefined)) {
    for (const key of CONNECTION_KEYS) {
      delete merged[key];
    }
  }
  return { ...merged, ...over };
}

function mergeServers(
  base: Readonly<Record<string, McpServerConfig>> | undefined,
  over: Readonly<Record<string, McpServerConfig | null>>,
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = { ...base };
  for (const [name, server] of Object.entries(over)) {
    if (server === null) {
      delete merged[name];
    } else {
      merged[name] = server;
    }
  }
  return merged;
}

export function applyProfile(file: FileConfig, name: string | undefined): ProfileResult {
  const { profiles, ...base } = file;
  if (name === undefined) {
    return { ok: true, config: base };
  }
  const profile = profiles && Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!profile) {
    const defined = Object.keys(profiles ?? {});
    return {
      ok: false,
      reason: `unknown profile ${JSON.stringify(name)} (${
        defined.length > 0 ? `defined: ${defined.join(", ")}` : "no profiles defined"
      })`,
    };
  }
  const { model, subagents, tools, contextAwareness, mcpServers, ...scalars } = profile;
  const config: FileConfig = { ...base, ...scalars };
  if (model) {
    config.model = mergeModel(base.model, model);
  }
  if (subagents) {
    config.subagents = { ...base.subagents, ...subagents };
  }
  if (contextAwareness) {
    config.contextAwareness = { ...base.contextAwareness, ...contextAwareness };
  }
  if (tools) {
    config.tools = { ...base.tools, ...tools };
  }
  if (mcpServers) {
    config.mcpServers = mergeServers(base.mcpServers, mcpServers);
  }
  return { ok: true, config };
}
