/**
 * The Docker/Podman `EngineHost` (docs/feat/docker-engine-seam.md §4): a
 * container is the workload (no sub-containers), driven over `@tentacle/docker`'s
 * `DockerClient` (no `docker` CLI). The SAME runtime (`engine-runtime.ts`) drives
 * it; only lifecycle + transport live here.
 *
 * Trust (AGENTS §7 "a pod is not trusted"): the container gets nothing from the
 * laptop but, on a local engine, the cwd (slice D, `workspace-mount.ts`: one
 * bind, `~/.ssh` and the config dir masked, probed after start) — no engine
 * socket, not privileged, no secret in its env — and the model stays on the
 * laptop (reverse-tunnelled by the runtime). The mount travels in the create
 * body over the engine socket; the exit-net child carries the endpoint (TLS
 * key included) in env, never argv.
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
  OWNER_LABEL,
  endpointLabel,
  spawnContainerDelete,
} from "@tentacle/docker";
import { type EngineHost, WorkloadRemovedError, type WorkloadState } from "./engine-host.ts";
import {
  WORKSPACE_LABELS,
  type WorkspaceMount,
  engineFacts,
  workspaceEngineOptions,
  workspaceLabels,
  workspaceMounts,
  workspaceProbeCommand,
  workspaceProbeProblem,
} from "./workspace-mount.ts";

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
  | "info"
>;

export interface DockerEngineHostOptions {
  readonly client: DockerClientLike;
  readonly endpoint: EngineEndpoint;
  readonly kind: "docker" | "podman";
  /** The exit net's spawner (tests); defaults to `spawnContainerDelete`. */
  readonly spawnDelete?: (endpoint: EngineEndpoint, name: string) => void;
  /** The laptop the workspace user is mapped from (tests); defaults to this process. */
  readonly laptop?: {
    readonly platform: string;
    readonly uid?: number | undefined;
    readonly gid?: number | undefined;
  };
}

export interface ContainerBodyOptions {
  /** The laptop folder (slice D): one structured bind + the M5b masks. */
  readonly workspace?: WorkspaceMount;
  /** The daemon exec's `uid:gid` (only labelled here; applied per exec). */
  readonly user?: string;
  readonly securityOpt?: readonly string[];
  /** Caller labels (slice E); the workspace labels win a clash. */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * The container `run` creates (pure): an idle keepalive the daemon is exec'd
 * into. Nothing from the host but, when planned, the laptop cwd (a bind, with
 * `~/.ssh` / the config dir masked) — no engine socket, no host network/pid,
 * not privileged, no env. No `AutoRemove`: it races our own remove with a 409
 * "removal in progress". `createContainer` adds the owner label.
 */
export function containerBody(
  image: string,
  options: ContainerBodyOptions = {},
): ContainerCreateBody {
  const { workspace } = options;
  return {
    Image: image,
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      Privileged: false,
      ...(workspace ? { Mounts: workspaceMounts(workspace) } : {}),
      ...(options.securityOpt ? { SecurityOpt: [...options.securityOpt] } : {}),
    },
    Labels: { ...options.labels, ...workspaceLabels(workspace, options.user) },
  };
}

/** How the daemon exec runs in a workspace container (its mount target + user). */
interface ExecDefaults {
  readonly workingDir: string;
  readonly user?: string;
}

/** A tentacle-made container's workspace, from its labels (anyone else's labels are ignored). */
function labelledDefaults(
  labels: Readonly<Record<string, string>> | null | undefined,
): ExecDefaults | undefined {
  const workingDir = labels?.[WORKSPACE_LABELS.workspace];
  if (labels?.[OWNER_LABEL] !== "true" || !workingDir) {
    return undefined;
  }
  const user = labels[WORKSPACE_LABELS.user];
  return user ? { workingDir, user } : { workingDir };
}

/** Docker Desktop's unshared-path refusal (and its podman / engine variants). */
const MOUNT_DENIED = /mounts denied|not shared from the host|bind source path does not exist/i;

const is404 = (error: unknown): boolean => error instanceof DockerApiError && error.status === 404;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** The Docker/Podman `EngineHost` for `endpoint`, over `client`. */
export function dockerEngineHost(options: DockerEngineHostOptions): EngineHost {
  const { client, endpoint, kind } = options;
  const spawnDelete = options.spawnDelete ?? ((ep, name) => spawnContainerDelete(ep, name));
  const cli = kind;
  const where = `${endpointLabel(endpoint)} (${endpoint.source})`;
  const laptop = options.laptop ?? {
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  };
  // Only a container THIS host created is ever started (`attach` never starts one).
  const created = new Set<string>();
  // The daemon exec's working dir + user, per container: set by `create` (the
  // plan) or `inspect` (the labels), so the first dial AND every redial land in
  // the workspace. One-shot execs (probe, injection) never get them: root.
  const execDefaults = new Map<string, ExecDefaults>();
  // The workspace to probe after start, per container this host created.
  const probes = new Map<string, WorkspaceMount>();

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
    async create(name, image, createOptions) {
      const workspace = createOptions?.workspace;
      // Engine facts only matter for a mount; unknown (info failed) → no
      // mapping and no SecurityOpt — the probe still catches an unusable mount.
      const engineOptions: ReturnType<typeof workspaceEngineOptions> = workspace
        ? await client.info().then(
            (info) => workspaceEngineOptions(engineFacts(info), { kind, ...laptop }),
            () => ({}),
          )
        : {};
      const body = containerBody(image, {
        ...(workspace ? { workspace } : {}),
        ...engineOptions,
        ...(createOptions?.labels || createOptions?.annotations
          ? { labels: { ...createOptions.annotations, ...createOptions.labels } }
          : {}),
      });
      // The client's 404 branch (no such image) is the only plain-`Error` reject
      // that starts with this prefix; API errors are `DockerApiError`s.
      const missingImage = (error: unknown): boolean =>
        !(error instanceof DockerApiError) &&
        error instanceof Error &&
        error.message.startsWith(`cannot create container ${name}:`);
      const conflict = (error: unknown): Error => {
        if (error instanceof DockerApiError && error.status === 409) {
          return new Error(
            `a container named "${name}" already exists on ${where} — pick another name or remove it (\`${cli} rm ${name}\`)`,
          );
        }
        if (
          workspace &&
          error instanceof DockerApiError &&
          MOUNT_DENIED.test(error.engineMessage)
        ) {
          return new Error(
            `${cli} cannot mount ${workspace.source}: ${error.engineMessage} — on Docker Desktop add it in Settings → Resources → File sharing; or use --no-mount`,
          );
        }
        return toError(error);
      };
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
      if (workspace) {
        probes.set(name, workspace);
        const { user } = engineOptions;
        execDefaults.set(
          name,
          user ? { workingDir: workspace.target, user } : { workingDir: workspace.target },
        );
      }
    },
    async waitForReady(name, opts) {
      if (created.has(name)) {
        await client.startContainer(name);
      }
      await client.waitForRunning(
        name,
        opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      );
      const workspace = probes.get(name);
      if (!workspace) {
        return;
      }
      // M5b: before the daemon (or the binary) goes in, prove the mount is
      // usable and every mask hides its secret. A miss removes the container
      // HERE, `--keep` or not: it must never stay up with unverified masks —
      // and a probe that cannot run (timeout, dropped exec) is a miss too.
      let problem: string | null;
      try {
        const result = await client.runExec(
          { container: name, command: workspaceProbeCommand(workspace) },
          undefined,
          { timeoutMs: 15_000 },
        );
        problem = workspaceProbeProblem(result, workspace);
      } catch (error) {
        problem = `workspace check failed: ${toError(error).message}`;
      }
      if (problem) {
        // Say what really happened to the container (Review F2).
        const outcome = await client.removeContainer(name).then(
          () => "The container was removed.",
          (error: unknown) =>
            `The container could NOT be removed (${toError(error).message}) — remove it yourself: \`${cli} rm -f ${name}\``,
        );
        throw new WorkloadRemovedError(`${problem}. ${outcome}`);
      }
    },
    async inspect(name): Promise<WorkloadState> {
      let status: string | undefined;
      let running: boolean | undefined;
      let defaults: ExecDefaults | undefined;
      try {
        const info = await client.inspectContainer(name);
        status = info.State?.Status;
        running = info.State?.Running;
        defaults = labelledDefaults(info.Config?.Labels);
      } catch (error) {
        if (is404(error)) {
          throw new Error(
            `container "${name}" not found on ${where} — check the name (\`${cli} ps\`); use \`run\` to create one`,
          );
        }
        throw toError(error);
      }
      // `attach` to a `run`-made (kept) container lands in its workspace, as its user.
      if (defaults) {
        execDefaults.set(name, defaults);
      }
      const workspace = defaults ? { workspace: defaults.workingDir } : {};
      if (status === "paused") {
        return {
          kind: "stopped",
          detail: `container "${name}" is paused — unpause it (\`${cli} unpause ${name}\`) and attach again`,
        };
      }
      if (running) {
        return { kind: "ready", ...workspace };
      }
      if (status === "restarting") {
        return { kind: "starting", detail: `container "${name}" is restarting`, ...workspace };
      }
      return {
        kind: "stopped",
        detail: `container "${name}" is ${status ?? "not running"} — start it yourself (\`${cli} start ${name}\`) and attach again; attach never starts a container`,
      };
    },
    async describe(name) {
      try {
        const info = await client.inspectContainer(name);
        return { status: info.State?.Status ?? "unknown", labels: { ...info.Config?.Labels } };
      } catch (error) {
        if (is404(error)) {
          return null;
        }
        throw toError(error);
      }
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
      const defaults = execDefaults.get(target.name);
      return client.openExec(
        {
          container: target.name,
          command: target.command,
          ...(defaults?.workingDir ? { workingDir: defaults.workingDir } : {}),
          ...(defaults?.user ? { user: defaults.user } : {}),
        },
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
