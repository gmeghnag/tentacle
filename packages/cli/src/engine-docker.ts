/**
 * The Docker/Podman `EngineHost` (docs/feat/docker-engine-seam.md §4): a
 * container is the workload (no sub-containers), driven over `@tentacle/docker`'s
 * `DockerClient` (no `docker` CLI). The SAME runtime (`pod-runtime.ts`) drives
 * it; only lifecycle + transport live here.
 *
 * Trust (AGENTS §7 "a pod is not trusted"): the container gets nothing from the
 * laptop — no binds, no engine socket, not privileged, no secret in its env —
 * and the model stays on the laptop (reverse-tunnelled by the runtime). The
 * exit-net child carries the endpoint (TLS key included) in env, never argv.
 *
 * Ownership: `run` creates and removes; `attach` only reads state and execs —
 * this host never starts a container it did not create, and `removeContainer`
 * refuses any container without tentacle's owner label (defence in depth).
 */
import { ChannelError } from "@tentacle/client";
import {
  type ContainerCreateBody,
  DockerApiError,
  type DockerClient,
  type EngineEndpoint,
  endpointLabel,
  spawnContainerDelete,
} from "@tentacle/docker";
import type { EngineHost, WorkloadState } from "./engine-host.ts";

/** The subset of `DockerClient` the host needs (injectable for tests). */
export type DockerClientLike = Pick<
  DockerClient,
  | "pullImage"
  | "createContainer"
  | "startContainer"
  | "inspectContainer"
  | "removeContainer"
  | "waitForRunning"
  | "openExec"
  | "runExec"
>;

export interface DockerEngineHostOptions {
  readonly client: DockerClientLike;
  readonly endpoint: EngineEndpoint;
  readonly kind: "docker" | "podman";
  /** The exit net's spawner (tests); defaults to `spawnContainerDelete`. */
  readonly spawnDelete?: (endpoint: EngineEndpoint, name: string) => void;
}

/**
 * The container `run` creates (pure): an idle keepalive the daemon is exec'd
 * into. Deliberately nothing from the host — no binds (slice C, opt-in), no
 * engine socket, no host network/pid, not privileged. No `AutoRemove`: it races
 * our own remove with a 409 "removal in progress". `createContainer` adds the
 * owner label.
 */
export function containerBody(image: string): ContainerCreateBody {
  return {
    Image: image,
    Cmd: ["sleep", "infinity"],
    HostConfig: { Privileged: false },
  };
}

const is404 = (error: unknown): boolean => error instanceof DockerApiError && error.status === 404;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** The Docker/Podman `EngineHost` for `endpoint`, over `client`. */
export function dockerEngineHost(options: DockerEngineHostOptions): EngineHost {
  const { client, endpoint, kind } = options;
  const spawnDelete = options.spawnDelete ?? ((ep, name) => spawnContainerDelete(ep, name));
  const cli = kind;
  const where = `${endpointLabel(endpoint)} (${endpoint.source})`;
  // Only a container THIS host created is ever started (`attach` never starts one).
  const created = new Set<string>();

  const noSubContainer = (container: string | undefined): void => {
    if (container) {
      throw new Error(
        `--container is a Kubernetes option: a ${cli} container has no sub-containers (got "${container}")`,
      );
    }
  };

  return {
    kind,
    noun: "container",
    where,
    async create(name, image) {
      const body = containerBody(image);
      // The client's 404 branch (no such image) is the only plain-`Error` reject
      // that starts with this prefix; API errors are `DockerApiError`s.
      const missingImage = (error: unknown): boolean =>
        !(error instanceof DockerApiError) &&
        error instanceof Error &&
        error.message.startsWith(`cannot create container ${name}:`);
      const conflict = (error: unknown): Error =>
        error instanceof DockerApiError && error.status === 409
          ? new Error(
              `a container named "${name}" already exists on ${where} — pick another name or remove it (\`${cli} rm ${name}\`)`,
            )
          : toError(error);
      try {
        await client.createContainer(name, body);
      } catch (error) {
        if (!missingImage(error)) {
          throw conflict(error);
        }
        // Parity with k8s `IfNotPresent`: pull only a missing image, then retry once.
        await client.pullImage(image);
        try {
          await client.createContainer(name, body);
        } catch (again) {
          throw conflict(again);
        }
      }
      created.add(name);
    },
    async waitForReady(name, opts) {
      if (created.has(name)) {
        await client.startContainer(name);
      }
      await client.waitForRunning(
        name,
        opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      );
    },
    async inspect(name): Promise<WorkloadState> {
      let status: string | undefined;
      let running: boolean | undefined;
      try {
        const info = await client.inspectContainer(name);
        status = info.State?.Status;
        running = info.State?.Running;
      } catch (error) {
        if (is404(error)) {
          throw new Error(
            `container "${name}" not found on ${where} — check the name (\`${cli} ps\`); use \`run\` to create one`,
          );
        }
        throw toError(error);
      }
      if (status === "paused") {
        return {
          kind: "stopped",
          detail: `container "${name}" is paused — unpause it (\`${cli} unpause ${name}\`) and attach again`,
        };
      }
      if (running) {
        return { kind: "ready" };
      }
      if (status === "restarting") {
        return { kind: "starting", detail: `container "${name}" is restarting` };
      }
      return {
        kind: "stopped",
        detail: `container "${name}" is ${status ?? "not running"} — start it yourself (\`${cli} start ${name}\`) and attach again; attach never starts a container`,
      };
    },
    async dialVerdict(name) {
      try {
        const state = (await client.inspectContainer(name)).State;
        if (state?.Status === "exited" || state?.Status === "dead") {
          return new ChannelError("gone", `container "${name}" is ${state.Status}`);
        }
        if (state?.Running && state.Status !== "paused") {
          return null;
        }
        return new ChannelError(
          "unreachable",
          `container "${name}" is ${state?.Status ?? "not running"}`,
        );
      } catch (error) {
        if (is404(error)) {
          return new ChannelError("gone", `container "${name}" no longer exists`);
        }
        // `dialError` returns a plain Error: no auth class is distinguishable (debt).
        return new ChannelError(
          "unreachable",
          `cannot reach the ${cli} engine: ${toError(error).message}`,
        );
      }
    },
    remove(name) {
      return client.removeContainer(name);
    },
    removeBestEffort(name) {
      try {
        spawnDelete(endpoint, name);
      } catch {
        // best-effort — the exit net must never break the exit.
      }
    },
    openExec(target, opts) {
      noSubContainer(target.container);
      return client.openExec(
        { container: target.name, command: target.command },
        opts?.onStderr ? { onStderr: opts.onStderr } : {},
      );
    },
    async runExec(target, input, opts) {
      noSubContainer(target.container);
      return client.runExec({ container: target.name, command: target.command }, input, opts);
    },
    execError(error) {
      // `@tentacle/docker` already explains a refused exec from the container's
      // state (not found / not running); nothing engine-specific to add.
      return toError(error);
    },
  };
}
