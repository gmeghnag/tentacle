/**
 * The real model provider for a resolved config — the one place the CLI builds
 * one. Every construction site (the agent, the sub-agents' per-type models, the
 * laptop side of the pod reverse-tunnel) calls this, so each gets the same
 * connection retry AND logs each retried drop to the daemon log: a recovered
 * blip shows nothing on screen, and this line is its only trace.
 */
import type { TentacleConfig } from "@tentacle/config";
import type { ModelProvider } from "@tentacle/core";
import { createModelProvider } from "@tentacle/providers";
import { logModelRetry } from "./daemon-log.ts";

export function configuredModelProvider(
  config: Pick<
    TentacleConfig,
    "provider" | "baseURL" | "model" | "apiKey" | "maxTokens" | "configDir"
  >,
  /** A per-type model id on the same endpoint; defaults to `config.model`. */
  model: string = config.model,
): ModelProvider {
  return createModelProvider({
    provider: config.provider,
    baseURL: config.baseURL,
    model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    onRetry: (info) => logModelRetry(config.configDir, info),
  });
}
