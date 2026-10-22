/**
 * `@tentacle/config` — layered configuration for the harness.
 *
 * Precedence: environment variables > `config.jsonc` > built-in defaults.
 * Secrets are resolved via `apiKeyCommand` so no API key need live in the
 * config file. The merge (`resolveConfig`) is pure; `loadConfig` adds the I/O
 * (scaffold, read, validate, run the key command).
 */
export * from "./schema.ts";
export * from "./defaults.ts";
export * from "./profile.ts";
export * from "./resolve.ts";
export * from "./load.ts";
export * from "./skills.ts";
export * from "./skills-scan.ts";
export * from "./hooks-scan.ts";
export * from "./packages.ts";
