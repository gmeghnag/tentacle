/**
 * `@tentacle/providers` — model provider adapters.
 *
 * Ships the OpenAI-compatible provider (any `/v1/chat/completions` endpoint,
 * local or cloud) and a native Anthropic Messages API provider
 * (`/v1/messages`), both behind the core `ModelProvider` contract, plus
 * `createModelProvider` — the single factory that selects between them and
 * wraps the choice in the connection retry (`retry.ts`).
 */
export * from "./sse.ts";
export * from "./openai-provider.ts";
export * from "./anthropic-provider.ts";
export * from "./retry.ts";
export * from "./select-provider.ts";
