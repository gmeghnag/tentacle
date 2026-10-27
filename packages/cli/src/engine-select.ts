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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  DockerClient,
  type EngineEndpoint,
  dialerFor,
  endpointLabel,
  resolveEngineEndpoint,
  resolvePodmanEndpoint,
} from "@tentacle/docker";
import { KubeClient, type KubeClientOptions, loadKubeClientOptions } from "@tentacle/k8s";
import { type DockerClientLike, dockerEngineHost } from "./engine-docker.ts";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { type PodCluster, kubeEngineHost } from "./engine-k8s.ts";

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
  },
): string | null {
  if (kind === "kubernetes") {
    if (flags.context) {
      return "--context is for --engine docker or podman (a docker context)";
    }
    if (flags.insecureTcp) {
      return "--insecure-docker-tcp is for --engine docker or podman";
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
    const { namespace } = options;
    const envServer = io.env.TENTACLE_K8S_SERVER;
    let auth: KubeClientOptions;
    if (envServer) {
      const token = io.env.TENTACLE_K8S_TOKEN;
      auth = {
        server: envServer,
        namespace: namespace ?? "default",
        ...(token ? { token } : {}),
      } as KubeClientOptions;
    } else {
      auth = loadKubeClientOptions({ ...(namespace ? { namespace } : {}) });
    }
    return {
      host: kubeEngineHost(io.kubeClient(auth), auth.namespace),
      namespace: auth.namespace,
    };
  }
  const shared = {
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.allowInsecureTcp ? { allowInsecureTcp: true } : {}),
    readFile: io.readFile,
  };
  const endpoint =
    kind === "docker"
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
  return { host: dockerEngineHost({ client: io.dockerClient(endpoint), endpoint, kind }) };
}
