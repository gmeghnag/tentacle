import { applyTestEnvGuard } from "./test-env-guard.ts";

// Bun `[test] preload` (bunfig.toml): runs once before any test file.
applyTestEnvGuard(process.env);
