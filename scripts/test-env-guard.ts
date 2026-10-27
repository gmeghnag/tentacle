import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Structural test guard (AGENTS.md §6): no test may reach a real cluster or
 * container engine because of the developer's shell. `bunfig.toml` preloads
 * `scripts/test-preload.ts`, which applies this before ANY test file loads:
 *
 * - every `TENTACLE_*` variable is deleted (tests set their own via `withEnv`);
 * - endpoint variables (`KUBECONFIG`, `DOCKER_HOST`, `CONTAINER_HOST`) point at
 *   paths that do not exist, so an accidental dial fails loudly;
 * - `HOME` / `XDG_*` point at an empty temp dir, so `~/.kube/config`,
 *   `~/.docker` and podman discovery find nothing.
 *
 * Explicit opt-ins keep their own variables (the live tests read them at load):
 * `TENTACLE_K8S_SERVER` (+ `_TOKEN`, `_NAMESPACE`) for live-k8s,
 * `TENTACLE_DOCKER_TESTS=1` (+ every `TENTACLE_DOCKER_*`, the docker client
 * env and `HOME`) for live-docker, `TENTACLE_SLOW_TESTS=1`.
 * `TENTACLE_POD_IMAGE` / `TENTACLE_ENGINE` are never kept.
 */
type Env = Record<string, string | undefined>;

const DOCKER_CLIENT_ENV = [
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "SSH_AUTH_SOCK",
];

export const NONEXISTENT = "/nonexistent-tentacle-test-guard";

export function applyTestEnvGuard(
  env: Env,
  scratch: string = mkdtempSync(join(tmpdir(), "tentacle-test-home-")),
): void {
  const keep = new Set<string>();
  if (env.TENTACLE_K8S_SERVER) {
    for (const key of ["TENTACLE_K8S_SERVER", "TENTACLE_K8S_TOKEN", "TENTACLE_K8S_NAMESPACE"])
      keep.add(key);
  }
  if (env.TENTACLE_SLOW_TESTS === "1") keep.add("TENTACLE_SLOW_TESTS");
  const liveDocker = env.TENTACLE_DOCKER_TESTS === "1";
  if (liveDocker) {
    for (const key of Object.keys(env)) {
      if (key.startsWith("TENTACLE_DOCKER_")) keep.add(key);
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("TENTACLE_") && !keep.has(key)) delete env[key];
  }
  env.KUBECONFIG = `${NONEXISTENT}/kubeconfig`;
  if (!liveDocker) {
    for (const key of DOCKER_CLIENT_ENV) delete env[key];
    env.DOCKER_HOST = `unix://${NONEXISTENT}/docker.sock`;
    env.CONTAINER_HOST = `unix://${NONEXISTENT}/podman.sock`;
    env.DOCKER_CONFIG = join(scratch, "docker");
    env.HOME = scratch;
  }
  env.XDG_CONFIG_HOME = join(scratch, "config");
  env.XDG_RUNTIME_DIR = join(scratch, "run");
}
