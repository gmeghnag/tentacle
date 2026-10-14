/**
 * Configuration lives in `@agent-harness/config` (layered env > file > default,
 * with `apiKeyCommand` secret resolution). Re-exported here so the CLI barrel
 * keeps surfacing `loadConfig` / `HarnessConfig`.
 */
export * from "@agent-harness/config";
