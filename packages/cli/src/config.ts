/**
 * Configuration lives in `@tentacle/config` (layered env > file > default,
 * with `apiKeyCommand` secret resolution). Re-exported here so the CLI barrel
 * keeps surfacing `loadConfig` / `TentacleConfig`.
 */
export * from "@tentacle/config";
