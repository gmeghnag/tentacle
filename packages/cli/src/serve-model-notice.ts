/**
 * What a `serve` daemon says about its own model at start-up (docs/fix/
 * connect-model-error-drops-connection.md, decision (d)).
 *
 * A `serve` daemon's model, endpoint and key are ITS config's — a client that
 * connects never carries them (docs/feat/config-carry.md). Run with no config
 * on that host, it therefore serves the built-in default endpoint with no key:
 * every turn comes back 401, which the user sees as a broken model rather than
 * a missing setting. One line before listening says which setting is missing.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "@tentacle/config";

/** The daemon's model settings this line reads (never a secret value). */
export interface ServeModelFacts {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly apiKeyCommand?: string;
}

/**
 * One line when this host has no model configured, else `null`. `null` unless
 * ALL of: no key from any source, and the endpoint + model are the built-in
 * defaults (an explicitly configured endpoint is a choice, not an oversight).
 */
export function serveModelNotice(config: ServeModelFacts): string | null {
  if (config.apiKey !== undefined || config.apiKeyCommand !== undefined) {
    return null;
  }
  if (config.baseURL !== DEFAULT_BASE_URL || config.model !== DEFAULT_MODEL) {
    return null;
  }
  return [
    "no model is configured on this host: every turn will fail until it is",
    `(set model.baseURL, model.model and model.apiKey — or TENTACLE_MODEL_API_KEY — with \`tentacle config\`; a client's own model is never used here)`,
  ].join(" ");
}
