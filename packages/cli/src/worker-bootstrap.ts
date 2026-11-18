import type { TentacleConfig } from "./config.ts";

/**
 * The first (object) message the main thread posts to `worker.ts`. The version
 * travels here because the worker must not import `version.ts`: its compile-time
 * marker would be inlined into the worker bundle as well, and the binary must
 * carry exactly one (scripts/build.ts).
 */
export interface WorkerBootstrap {
  readonly config: TentacleConfig;
  readonly version: string;
  /**
   * The laptop store dir holding this project's sessions, which the worker may
   * READ (never write) for a RESUMED session's artifacts
   * (docs/feat/model-artifacts.md D11). Absent → nothing is restored.
   */
  readonly artifactsDir?: string;
}
