/**
 * Pure discovery of the local Podman API socket for `--engine podman`
 * (docs/feat/docker-engine-cli.md, owner decision: no `DOCKER_HOST` needed).
 * The filesystem is injected (`exists`, `listDir`, `readFile`), so every rule
 * is unit-testable without a real Podman.
 *
 * Precedence: an explicit `--context` (a docker context, e.g. Docker Desktop's
 * `podman` one) > `CONTAINER_HOST` (podman's own override) > the first
 * existing well-known socket. `DOCKER_HOST` / `DOCKER_CONTEXT` are ignored on
 * purpose: they name Docker's engine, and honouring them would silently run
 * "podman" on Docker.
 */
import {
  type EngineEndpoint,
  resolveEngineEndpoint,
  resolveHostEndpoint,
} from "./engine-endpoint.ts";

export interface PodmanEndpointInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** An explicit docker context (`--context`). Wins over everything. */
  readonly context?: string;
  /** Accept a plaintext `tcp://` `CONTAINER_HOST` (`--insecure-docker-tcp`). */
  readonly allowInsecureTcp?: boolean;
  /** `process.platform`. */
  readonly platform: string;
  /** The user's uid (`/run/user/<uid>`); undefined where there is none. */
  readonly uid?: number;
  /** `os.tmpdir()`, the fallback for `TMPDIR` (macOS machine sockets live there). */
  readonly tmpdir: string;
  /** Home directory fallback when `env.HOME` is unset. */
  readonly homeDir?: string;
  readonly exists: (path: string) => boolean;
  /** A directory's entry names; empty when it does not exist. */
  readonly listDir: (dir: string) => readonly string[];
  /** For `--context` (the docker context store). */
  readonly readFile: (path: string) => string | undefined;
}

const SOURCE = "podman socket (auto-discovered)";
const MACHINE_SOCKET = "podman-machine-default-api.sock";

function join(dir: string, ...parts: string[]): string {
  return [dir.replace(/\/+$/, ""), ...parts].join("/");
}

/** Where the Podman API socket may be, most specific first. */
export function podmanSocketCandidates(input: PodmanEndpointInput): string[] {
  const { env } = input;
  const out: string[] = [];
  const add = (path: string): void => {
    if (!out.includes(path)) {
      out.push(path);
    }
  };
  if (input.platform === "darwin") {
    // podman 5: the machine's API socket under $TMPDIR/podman (the default
    // machine first, then any other machine's); podman 4: under ~/.local/share.
    const dir = join(env.TMPDIR || input.tmpdir, "podman");
    add(join(dir, MACHINE_SOCKET));
    for (const entry of [...input.listDir(dir)].sort()) {
      if (entry.endsWith("-api.sock")) {
        add(join(dir, entry));
      }
    }
    const home = env.HOME ?? input.homeDir ?? "";
    add(join(home, ".local/share/containers/podman/machine/podman.sock"));
    add(join(home, ".local/share/containers/podman/machine/qemu/podman.sock"));
    return out;
  }
  // Linux (and the rest): rootless first, then rootful.
  if (env.XDG_RUNTIME_DIR) {
    add(join(env.XDG_RUNTIME_DIR, "podman/podman.sock"));
  }
  if (input.uid !== undefined) {
    add(`/run/user/${input.uid}/podman/podman.sock`);
  }
  add("/run/podman/podman.sock");
  return out;
}

/** Resolve the Podman engine endpoint, or throw an actionable `Error`. */
export function resolvePodmanEndpoint(input: PodmanEndpointInput): EngineEndpoint {
  if (input.context !== undefined) {
    return resolveEngineEndpoint({
      env: input.env,
      context: input.context,
      readFile: input.readFile,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(input.allowInsecureTcp !== undefined ? { allowInsecureTcp: input.allowInsecureTcp } : {}),
    });
  }
  const containerHost = input.env.CONTAINER_HOST;
  if (containerHost) {
    if (/^ssh:\/\//i.test(containerHost)) {
      throw new Error(
        "CONTAINER_HOST=ssh:// is not supported for --engine podman yet (a podman ssh connection names a remote socket tentacle cannot dial) — unset it to use the local Podman socket, or use --engine docker with DOCKER_HOST=ssh://… if that host has the docker CLI",
      );
    }
    return resolveHostEndpoint(containerHost, "CONTAINER_HOST", {
      ...(input.allowInsecureTcp !== undefined ? { allowInsecureTcp: input.allowInsecureTcp } : {}),
    });
  }
  const candidates = podmanSocketCandidates(input);
  const found = candidates.find((path) => input.exists(path));
  if (found === undefined) {
    throw new Error(
      `no Podman socket found (looked in: ${candidates.join(", ")}) — start it with \`podman machine start\` (macOS) or \`systemctl --user enable --now podman.socket\` (Linux), or set CONTAINER_HOST`,
    );
  }
  return { kind: "unix", path: found, local: true, source: SOURCE };
}
