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
}
