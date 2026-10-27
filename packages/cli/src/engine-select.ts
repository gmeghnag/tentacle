/**
 * Which engine `run`/`attach` drive, and the `EngineHost` for it
 * (docs/feat/docker-engine-cli.md). Choosing the engine is ONLY choosing the
 * host: the runtime (`engine-runtime.ts`) is the same for all three.
 *
 * Precedence (owner, 2026-10-27): `--engine` > `TENTACLE_ENGINE` > profile >
 * user config (`engine:`, already merged by `loadConfig`) > `kubernetes`. An
 * unknown value — flag or env — is a usage error, never a silent fallback to
 * another engine.
 */
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DockerClient,
  type EngineEndpoint,
  dialerFor,
  endpointLabel,
  resolveEngineEndpoint,
  resolveHostEndpoint,
  resolvePodmanEndpoint,
} from "@tentacle/docker";
import {
  KubeClient,
  type KubeClientOptions,
  currentKubeContext,
  loadKubeClientOptions,
} from "@tentacle/k8s";
import { type DockerClientLike, dockerEngineHost } from "./engine-docker.ts";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { type PodCluster, kubeEngineHost } from "./engine-k8s.ts";
import type { KeptEntry } from "./kept.ts";
import {
  type CaseFs,
  type HideEntry,
  type HideFileFs,
  type HideFs,
  type HidePath,
  type WorkspaceInput,
  caseAliasedFiles,
  loadHideFile,
  resolveHideFile,
} from "./workspace-mount.ts";

export const ENGINES: readonly EngineKind[] = ["kubernetes", "docker", "podman"];

export type EngineChoice =
  | { readonly ok: true; readonly kind: EngineKind }
  | { readonly ok: false; readonly error: string };

function parseEngine(value: string, source: string): EngineChoice {
  return (ENGINES as readonly string[]).includes(value)
    ? { ok: true, kind: value as EngineKind }
    : {
        ok: false,
        error: `unknown engine ${JSON.stringify(value)} (${source}): use kubernetes, docker or podman`,
      };
}

/** flag > env (`TENTACLE_ENGINE`) > configured (profile/file) > kubernetes. */
export function chooseEngine(input: {
  readonly flag?: string | undefined;
  readonly env?: string | undefined;
  readonly configured?: EngineKind | undefined;
}): EngineChoice {
  if (input.flag !== undefined) {
    return parseEngine(input.flag, "--engine");
  }
  if (input.env !== undefined && input.env !== "") {
    return parseEngine(input.env, "TENTACLE_ENGINE");
  }
  return { ok: true, kind: input.configured ?? "kubernetes" };
}

/** The workload's noun in log lines: `[pod] …` / `[container] …`. */
export function engineNoun(kind: EngineKind): "pod" | "container" {
  return kind === "kubernetes" ? "pod" : "container";
}

/**
 * An engine-specific flag given for the wrong engine → the usage error (the
 * strict-args rule: never silently ignored), else `null`.
 */
export function engineFlagProblem(
  kind: EngineKind,
  flags: {
    readonly namespace?: boolean;
    readonly container?: boolean;
    readonly context?: boolean;
    readonly insecureTcp?: boolean;
    readonly noMount?: boolean;
    readonly confirmMount?: boolean;
  },
): string | null {
  if (kind === "kubernetes") {
    if (flags.context) {
      return "--context is for --engine docker or podman (a docker context)";
    }
    if (flags.insecureTcp) {
      return "--insecure-docker-tcp is for --engine docker or podman";
    }
    if (flags.noMount) {
      return "--no-mount is for --engine docker or podman (a pod never mounts a laptop folder)";
    }
    if (flags.confirmMount) {
      return "--confirm-mount is for --engine docker or podman (a pod never mounts a laptop folder)";
    }
    return null;
  }
  if (flags.namespace) {
    return "--namespace is for --engine kubernetes (a container has no namespace)";
  }
  if (flags.container) {
    return "--container is for --engine kubernetes (a container has no sub-containers)";
  }
  return null;
}

/**
 * `run --keep[=true|false]`: flag > profile > user config (`keep:`) > true. A bare
 * `--keep` is `bare`; `--keep=<v>` is `value`; any value but true/false is an error.
 */
export function resolveKeep(input: {
  readonly bare?: boolean;
  readonly value?: string | undefined;
  readonly configured?: boolean | undefined;
}): { readonly ok: true; readonly keep: boolean } | { readonly ok: false; readonly error: string } {
  if (input.value !== undefined) {
    if (input.value === "true" || input.value === "false") {
      return { ok: true, keep: input.value === "true" };
    }
    return { ok: false, error: `--keep takes true or false, got "${input.value}"` };
  }
  return { ok: true, keep: input.bare === true || (input.configured ?? true) };
}

/** The command that re-attaches to a workload `run --keep` left up. */
export function attachCommand(
  kind: EngineKind,
  name: string,
  where: {
    readonly namespace?: string | undefined;
    readonly context?: string | undefined;
    readonly insecureTcp?: boolean | undefined;
    readonly binDir?: string | undefined;
  } = {},
): string {
  const scope =
    kind === "kubernetes"
      ? where.namespace !== undefined
        ? ` -n ${where.namespace}`
        : ""
      : (where.context !== undefined ? ` --context ${where.context}` : "") +
        (where.insecureTcp ? " --insecure-docker-tcp" : "");
  const bin = where.binDir !== undefined ? ` --bin-dir ${where.binDir}` : "";
  return `tentacle attach --engine ${kind}${scope}${bin} ${name}`;
}

/** The pre-runtime failure line (host setup): k8s keeps its historical wording. */
export function setupFailureLine(kind: EngineKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return kind === "kubernetes"
    ? `[pod] cluster auth failed: ${message}\n`
    : `[container] failed: ${message}\n`;
}

export interface EngineHostOptions {
  /** kubernetes: `--namespace` / `TENTACLE_POD_NAMESPACE`. */
  readonly namespace?: string | undefined;
  /** docker/podman: `--context`. */
  readonly context?: string | undefined;
  /** docker/podman: `--insecure-docker-tcp`. */
  readonly allowInsecureTcp?: boolean;
  /** docker/podman, a kept entry (slice E): this engine URL, instead of discovery / `DOCKER_HOST`. */
  readonly host?: string | undefined;
  /** kubernetes, a kept entry: this kubeconfig context instead of the current one. */
  readonly kubeContext?: string | undefined;
  /** kubernetes, a kept entry: this API server (the `TENTACLE_K8S_SERVER` it was made with). */
  readonly server?: string | undefined;
}

/** The host's surroundings, injectable for tests. */
export interface EngineHostIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly uid?: number;
  readonly tmpdir: string;
  readonly homeDir: string;
  readonly readFile: (path: string) => string | undefined;
  readonly exists: (path: string) => boolean;
  readonly listDir: (dir: string) => readonly string[];
  readonly kubeClient: (options: KubeClientOptions) => PodCluster;
  readonly dockerClient: (endpoint: EngineEndpoint) => DockerClientLike;
}

export function defaultEngineHostIO(): EngineHostIO {
  const uid = process.getuid?.();
  return {
    env: process.env,
    platform: process.platform,
    ...(uid !== undefined ? { uid } : {}),
    tmpdir: tmpdir(),
    homeDir: homedir(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (path) => existsSync(path),
    listDir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    kubeClient: (options) => new KubeClient(options),
    dockerClient: (endpoint) =>
      new DockerClient({ dial: dialerFor(endpoint), endpointLabel: endpointLabel(endpoint) }),
  };
}

export interface BuiltEngineHost {
  readonly host: EngineHost;
  /** kubernetes: the resolved namespace (for the `--keep` attach hint). */
  readonly namespace?: string;
  /** docker/podman: the endpoint (its locality decides the workspace mount). */
  readonly endpoint?: EngineEndpoint;
  /** kubernetes: the kubeconfig context used (absent with a `server` override). */
  readonly kubeContext?: string;
  /** kubernetes: the `TENTACLE_K8S_SERVER` (or kept-entry) server used. */
  readonly server?: string;
}

/** An endpoint as a URL `resolveHostEndpoint` takes back (no TLS material, no secret). */
export function endpointUrl(endpoint: EngineEndpoint): string {
  switch (endpoint.kind) {
    case "unix":
      return `unix://${endpoint.path}`;
    case "tcp":
      return `tcp://${endpoint.host}:${endpoint.port}`;
    case "ssh":
      return `ssh://${endpoint.user ? `${endpoint.user}@` : ""}${endpoint.host}${endpoint.port ? `:${endpoint.port}` : ""}`;
  }
}

/** Where a kept workload lives, for its index entry (slice E): locators only. */
export type KeptLocation = Pick<
  KeptEntry,
  "endpoint" | "context" | "server" | "namespace" | "insecureTcp"
>;

/** The locator of a workload created on `built` (`run`). */
export function keptLocation(
  kind: EngineKind,
  built: BuiltEngineHost,
  flags: { readonly context?: string | undefined; readonly insecureTcp?: boolean },
): KeptLocation {
  if (kind === "kubernetes") {
    return {
      namespace: built.namespace ?? "default",
      ...(built.server !== undefined
        ? { server: built.server }
        : built.kubeContext !== undefined
          ? { context: built.kubeContext }
          : {}),
    };
  }
  return {
    ...(built.endpoint ? { endpoint: endpointUrl(built.endpoint) } : {}),
    ...(flags.context !== undefined ? { context: flags.context } : {}),
    ...(flags.insecureTcp ? { insecureTcp: true } : {}),
  };
}

/** A kept entry → the `buildEngineHost` options that dial the SAME place again. */
export function hostOptionsFor(entry: Pick<KeptEntry, "engine"> & KeptLocation): EngineHostOptions {
  if (entry.engine === "kubernetes") {
    return {
      namespace: entry.namespace,
      ...(entry.server !== undefined ? { server: entry.server } : {}),
      ...(entry.server === undefined && entry.context !== undefined
        ? { kubeContext: entry.context }
        : {}),
    };
  }
  return {
    ...(entry.context !== undefined
      ? { context: entry.context }
      : entry.endpoint !== undefined
        ? { host: entry.endpoint }
        : {}),
    ...(entry.insecureTcp ? { allowInsecureTcp: true } : {}),
  };
}

/**
 * The laptop facts `planWorkspace` needs, resolved here (IO): every path the
 * masks and the danger check compare is a realpath, so a symlink cannot
 * bypass them. `~/.ssh` is passed only when it exists.
 */
export function laptopWorkspaceInput(input: {
  readonly kind: EngineKind;
  readonly endpoint?: EngineEndpoint | undefined;
  readonly noMount: boolean;
  readonly cwd: string;
  readonly configDir: string;
  readonly binDir: string;
  /** `hideList(config.mount, config.apiKeyCommand)` — resolved here. */
  readonly hide: readonly HideEntry[];
  /** `apiKeyFileUnknown(config.apiKeyCommand)`: passed through to the plan's warning. */
  readonly keyFileUnknown?: boolean;
  readonly homeDir?: string;
}): WorkspaceInput {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const logicalHome = input.homeDir ?? homedir();
  const home = real(logicalHome);
  const ssh = join(logicalHome, ".ssh");
  // `~/x` → home; absolute as is; relative (the key file of `cat key`) → the cwd,
  // where `apiKeyCommand` runs. A missing entry is skipped (nothing to hide).
  const hide: HidePath[] = [];
  let statProblem: string | undefined;
  for (const entry of input.hide) {
    const path = entry.path.startsWith("~/")
      ? join(logicalHome, entry.path.slice(2))
      : resolve(input.cwd, entry.path);
    let file: boolean;
    try {
      file = !statSync(path).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      // Not "absent": we cannot tell, so fail closed rather than drop the mask.
      statProblem ??= `cannot check ${entry.label} (${path}) to hide it from the container: ${
        error instanceof Error ? error.message : String(error)
      } — fix its permissions, or remove it from the hide list`;
      continue;
    }
    hide.push({
      label: entry.label,
      path: real(path),
      file,
      ...(entry.always ? { always: true } : {}),
    });
  }
  // `<cwd>/.tentacle/hide` (owner 2026-10-27): per-project patterns that ADD to
  // the list, resolved now to existing paths. Read only when a mount will happen.
  let hideProblem: string | undefined;
  let hideWarnings: readonly string[] = [];
  let caseAliased: string[] = [];
  if (!input.noMount && input.kind !== "kubernetes" && input.endpoint?.local === true) {
    const source = real(input.cwd);
    const loaded = loadHideFile(source, nodeHideFileFs());
    hideProblem = loaded.problem;
    if (loaded.text !== undefined) {
      const resolved = resolveHideFile(loaded.text, source, nodeHideFs());
      hideProblem = resolved.problem;
      hideWarnings = resolved.warnings;
      hide.push(...resolved.paths);
    }
    // Every hidden FILE inside the mount: can another spelling reach it?
    caseAliased = caseAliasedFiles(
      hide.filter((h) => h.file && h.path.startsWith(`${source}/`)).map((h) => h.path),
      nodeCaseFs(),
    );
  }
  const problem = statProblem ?? hideProblem;
  let entries: readonly string[] = [];
  try {
    entries = readdirSync(input.cwd);
  } catch {
    // unreadable: the probe just checks the dir itself
  }
  return {
    engine: input.kind,
    endpointLocal: input.endpoint?.local ?? false,
    ...(input.endpoint ? { endpointLabel: endpointLabel(input.endpoint) } : {}),
    noMount: input.noMount,
    cwd: input.cwd,
    realCwd: real(input.cwd),
    home,
    configDir: real(input.configDir),
    ...(existsSync(ssh) ? { sshDir: real(ssh) } : {}),
    hide,
    ...(problem !== undefined ? { hideProblem: problem } : {}),
    ...(hideWarnings.length > 0 ? { hideWarnings } : {}),
    ...(input.keyFileUnknown ? { keyFileUnknown: true } : {}),
    ...(caseAliased.length > 0 ? { caseAliased } : {}),
    binDir: input.binDir,
    entries,
  };
}

/** The real directory walk for `.tentacle/hide` (the pure resolver takes it injected). */
function nodeHideFs(): HideFs {
  return {
    list: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
          link: e.isSymbolicLink(),
        }));
      } catch {
        return undefined; // warned by the resolver
      }
    },
    link: (path) => {
      try {
        const real = realpathSync(path);
        return { real, dir: statSync(real).isDirectory() };
      } catch {
        return undefined;
      }
    },
  };
}

/** The real `.tentacle/hide` reads: ENOENT/ENOTDIR = absent; a FIFO is never opened blocking. */
function nodeHideFileFs(): HideFileFs {
  return {
    lstat: (path) => {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return undefined;
        }
        throw error;
      }
      return {
        kind: stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : "other",
        size: stat.size,
      };
    },
    realpath: (path) => realpathSync(path),
    read: (path, max) => {
      // Re-checked on the open fd: the path may have been swapped since `lstat`.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > max) {
          throw new Error("changed while being read");
        }
        return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** `lstat` identity for the case check (`caseAliasedFiles`). */
function nodeCaseFs(): CaseFs {
  return {
    id: (path) => {
      try {
        const stat = lstatSync(path, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Build the `EngineHost` for `kind`, or throw (the caller prints
 * `setupFailureLine`). kubernetes: kubeconfig (current context), or
 * `TENTACLE_K8S_SERVER`/`_TOKEN` as an explicit override. docker: the docker
 * CLI's endpoint precedence. podman: socket discovery.
 */
export function buildEngineHost(
  kind: EngineKind,
  options: EngineHostOptions,
  io: EngineHostIO = defaultEngineHostIO(),
): BuiltEngineHost {
  if (kind === "kubernetes") {
    const { namespace, kubeContext } = options;
    // A kept entry's server wins over today's env: it re-dials where it was made.
    const server =
      options.server ?? (kubeContext === undefined ? io.env.TENTACLE_K8S_SERVER : undefined);
    let auth: KubeClientOptions;
    if (server) {
      const token = io.env.TENTACLE_K8S_TOKEN;
      auth = {
        server,
        namespace: namespace ?? "default",
        ...(token ? { token } : {}),
      } as KubeClientOptions;
    } else {
      auth = loadKubeClientOptions({
        ...(namespace ? { namespace } : {}),
        ...(kubeContext ? { context: kubeContext } : {}),
      });
    }
    const context = server ? undefined : (kubeContext ?? currentKubeContext());
    return {
      host: kubeEngineHost(io.kubeClient(auth), auth.namespace),
      namespace: auth.namespace,
      ...(server ? { server } : {}),
      ...(context !== undefined ? { kubeContext: context } : {}),
    };
  }
  const shared = {
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.allowInsecureTcp ? { allowInsecureTcp: true } : {}),
    readFile: io.readFile,
  };
  const endpoint = options.host
    ? resolveHostEndpoint(options.host, "the kept workload's engine", {
        ...(options.allowInsecureTcp ? { allowInsecureTcp: true } : {}),
      })
    : kind === "docker"
      ? resolveEngineEndpoint({ env: io.env, homeDir: io.homeDir, ...shared })
      : resolvePodmanEndpoint({
          env: io.env,
          platform: io.platform,
          ...(io.uid !== undefined ? { uid: io.uid } : {}),
          tmpdir: io.tmpdir,
          homeDir: io.homeDir,
          exists: io.exists,
          listDir: io.listDir,
          ...shared,
        });
  return {
    host: dockerEngineHost({ client: io.dockerClient(endpoint), endpoint, kind }),
    endpoint,
  };
}
