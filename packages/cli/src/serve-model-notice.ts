/**
 * What a `serve` daemon says about its own model at start-up (docs/fix/
 * connect-model-error-drops-connection.md, decision (d)).
 *
 * A `serve` daemon's model, endpoint and key are ITS config's — a client that
 * connects never carries them (docs/feat/config-carry.md). Run with no config
 * on that host, it serves the built-in default endpoint with no key: a keyless
 * local llama-server, which is valid in itself, but a daemon pointed nowhere
 * real then fails each turn with the provider's own 401/refused, which the user
 * reads as a broken model rather than a missing setting. One line before
 * listening says what it is using and which setting to change if turns fail.
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
 *
 * The defaults are NOT a broken setup: `http://localhost:8080/v1` with model
 * `"default"` is a keyless local llama-server, which the config template is
 * written around (`config/defaults.ts`). So the line states the fact and hints
 * at the fix "if turns fail" — it never claims every turn will fail.
 */
export function serveModelNotice(config: ServeModelFacts): string | null {
  if (config.apiKey !== undefined || config.apiKeyCommand !== undefined) {
    return null;
  }
  if (config.baseURL !== DEFAULT_BASE_URL || config.model !== DEFAULT_MODEL) {
    return null;
  }
  return [
    `using the built-in default model endpoint (${DEFAULT_BASE_URL}, model "${DEFAULT_MODEL}") with no API key —`,
    "if turns fail (401 / connection refused), set model.baseURL/model.model/model.apiKey with `tentacle config` on this host;",
    "a client's own model is never used here",
  ].join(" ");
}
