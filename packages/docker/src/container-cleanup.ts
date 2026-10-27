/**
 * Best-effort container removal that survives `process.exit` — the Ctrl+C /
 * SIGTERM safety net of `run` on a Docker/Podman engine (the counterpart of
 * `@tentacle/k8s`'s `pod-cleanup.ts`; docs/feat/docker-engine-seam.md §5).
 *
 * `process.exit` still fires `process` `exit` handlers on every exit path, but
 * an `exit` handler cannot await: so it spawns a **detached, `unref`'d child**
 * that does the remove and exits. Unlike the k8s net (one static `DELETE`), the
 * child reuses the real `DockerClient` — `removeContainer` is kill-first,
 * bounded, 404-idempotent and refuses a container without `OWNER_LABEL` — so
 * unix / TCP+TLS / ssh are one code path and a user's container is never
 * removed, even by the net.
 *
 * The child command adapts to how the parent runs (`containerDeleteCommand`):
 * a compiled binary re-executes itself with the hidden `__delete-container`
 * subcommand; from source it runs `bun -e` importing THIS module by absolute
 * path. The endpoint (TLS PEM contents included) and the container id travel
 * in env vars, never argv (visible in `ps`).
 */
import { DockerClient } from "./client.ts";
import { dialerFor } from "./engine-dialer.ts";
import { type EngineEndpoint, endpointLabel } from "./engine-endpoint.ts";

/**
 * The hidden subcommand a compiled binary's exit-net child runs. ONE constant
 * for both ends (this command builder and `main.ts`'s dispatch), so a rename
 * cannot silently orphan containers (docs/feat/docker-engine-cli.md).
 */
export const DELETE_CONTAINER_SUBCOMMAND = "__delete-container";
export const CONTAINER_DELETE_ID_ENV = "TENTACLE_CONTAINER_DELETE_ID";
export const DOCKER_ENDPOINT_ENV = "TENTACLE_DOCKER_ENDPOINT";
/** The child's whole budget (kill + delete, connects included). */
export const CONTAINER_DELETE_TIMEOUT_MS = 15_000;

/** The options object handed to `Bun.spawn` (kept narrow for testability). */
export interface ContainerDeleteSpawnOptions {
  readonly detached: true;
  readonly stdio: ["ignore", "ignore", "ignore"];
}

/** A spawned child we only need to `unref`. */
export interface ContainerDeleteChild {
  unref(): void;
}

/** Injectable spawner (tests assert command / env / options without a child). */
export type ContainerDeleteSpawner = (
  cmd: string[],
  env: Record<string, string>,
  options: ContainerDeleteSpawnOptions,
) => ContainerDeleteChild;

/** The removal the child performs (the `DockerClient` subset; injectable for tests). */
export interface ContainerRemover {
  removeContainer(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
}

/**
 * The command the detached child runs. From a compiled binary (`execPath` is
 * not `bun`) → the same binary's hidden `__delete-container`. From source →
 * `bun -e` importing `modulePath` (a path is not a secret).
 */
export function containerDeleteCommand(
  execPath: string,
  modulePath: string = import.meta.path,
): string[] {
  const base = execPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const isBun = base === "bun" || base.startsWith("bun-");
  return isBun
    ? [
        "bun",
        "-e",
        `const { deleteContainerFromEnv } = await import(${JSON.stringify(modulePath)}); await deleteContainerFromEnv(); process.exit(0);`,
      ]
    : [execPath, DELETE_CONTAINER_SUBCOMMAND];
}

/**
 * Spawn the detached remover child for container `id` on `ep`. Never throws: a
 * spawn failure is swallowed — the safety net must not break the exit.
 */
export function spawnContainerDelete(
  ep: EngineEndpoint,
  id: string,
  spawn: ContainerDeleteSpawner = (cmd, env, options) => Bun.spawn(cmd, { env, ...options }),
  execPath: string = process.execPath,
): void {
  try {
    // Carry the parent's environment (PATH, SSH_AUTH_SOCK, …) plus the delete config.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env[CONTAINER_DELETE_ID_ENV] = id;
    env[DOCKER_ENDPOINT_ENV] = JSON.stringify(ep);
    const child = spawn(containerDeleteCommand(execPath), env, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  } catch {
    // best-effort — a spawn failure must never break the exit.
  }
}

const KINDS: ReadonlySet<string> = new Set(["unix", "tcp", "ssh"]);

/** Parse the endpoint the parent serialised; `undefined` when absent or malformed. */
function parseEndpoint(raw: string | undefined): EngineEndpoint | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const ep = JSON.parse(raw) as { kind?: unknown };
    return typeof ep === "object" && ep !== null && KINDS.has(String(ep.kind))
      ? (ep as EngineEndpoint)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The child's body (the hidden `__delete-container`, or the `bun -e` import):
 * read the endpoint + id from env and remove the container, bounded. Never
 * throws; resolves once the call settles.
 */
export async function deleteContainerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  makeClient: (ep: EngineEndpoint) => ContainerRemover = (ep) =>
    new DockerClient({ dial: dialerFor(ep), endpointLabel: endpointLabel(ep) }),
): Promise<void> {
  const id = env[CONTAINER_DELETE_ID_ENV];
  const ep = parseEndpoint(env[DOCKER_ENDPOINT_ENV]);
  if (!id || !ep) {
    return;
  }
  try {
    await makeClient(ep).removeContainer(id, { timeoutMs: CONTAINER_DELETE_TIMEOUT_MS });
  } catch {
    // best-effort — refused (not ours), unreachable or timed out: nothing to do.
  }
}
