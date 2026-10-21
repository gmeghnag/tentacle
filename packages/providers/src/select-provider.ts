/**
 * Provider selection: the single rule that maps the resolved config's provider
 * kind onto a concrete `ModelProvider`. Every construction site (the CLI wiring
 * and the pod runtimes) calls this instead of naming a provider class, so the
 * `openai | anthropic` choice lives in exactly one place.
 */
import type { ModelProvider } from "@tentacle/core";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { OpenAIProvider } from "./openai-provider.ts";
import { type RetryInfo, RetryingModelProvider } from "./retry.ts";

/** A provider kind understood by the harness. */
export type ProviderKind = "openai" | "anthropic";

export interface CreateModelProviderOptions {
  /** Provider kind. Defaults to `"openai"` when unset (existing behaviour). */
  readonly provider?: ProviderKind;
  /** Base URL including the API version (`.../v1` for both kinds). */
  readonly baseURL: string;
  /** Model id passed to the endpoint. */
  readonly model: string;
  readonly apiKey?: string;
  /** Max output tokens when the request sets none (`model.maxTokens`). */
  readonly maxTokens?: number;
  /** Injectable fetch, for tests. */
  readonly fetch?: typeof fetch;
  /** Told about each retried connection drop (the caller logs it). */
  readonly onRetry?: (info: RetryInfo) => void;
}

/**
 * The provider for `options.provider`, wrapped in `RetryingModelProvider` so a
 * connection that drops before any output is retried for every construction
 * site at once.
 */
export function createModelProvider(options: CreateModelProviderOptions): RetryingModelProvider {
  const config = {
    baseURL: options.baseURL,
    model: options.model,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
  // `openai` is the default (existing behaviour); the config schema is the
  // first gate against an unknown kind, so this only branches on `anthropic`.
  const inner: ModelProvider =
    options.provider === "anthropic" ? new AnthropicProvider(config) : new OpenAIProvider(config);
  return new RetryingModelProvider(inner, options.onRetry ? { onRetry: options.onRetry } : {});
}
