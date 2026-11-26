/**
 * Which container may be shown to the paired devices, and where it is dialled
 * (docs/feat/container-apps-devices.md OD3/OD4). Pure: every fact comes from
 * the engine's inspect, the model's strings never reach it. Fail-closed: what
 * cannot be checked is refused.
 */
import { posix } from "node:path";
import type { PreviewEngine, PreviewFacts, PreviewResolution } from "@tentacle/core";
import { type EngineEndpoint, endpointLabel } from "./engine-endpoint.ts";
import type { ContainerInspect, PortBinding } from "./types.ts";

export interface PreviewTargetInput {
  readonly inspect: ContainerInspect;
  readonly port: number;
  readonly engine: PreviewEngine;
  readonly endpoint: EngineEndpoint;
  /** The caller's `XDG_RUNTIME_DIR`: where rootless engines listen. OD4. */
  readonly runtimeDir?: string | undefined;
}

/** `HostIp` values published on loopback (the last two also on the LAN). OD3. */
const WILDCARD: readonly string[] = ["0.0.0.0", ""];
const LOOPBACK = "127.0.0.1";

/** Socket basenames that mean "this container drives an engine". OD4. */
const SOCKET_NAMES: readonly string[] = ["docker.sock", "podman.sock"];

/** Where engines listen by default, under both spellings of `/run`. OD4. */
const DEFAULT_SOCKETS: readonly string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/podman/podman.sock",
  "/run/podman/podman.sock",
];

/** The rootless ones, relative to `XDG_RUNTIME_DIR` (`docker`: its state dir). */
const ROOTLESS_PATHS: readonly string[] = ["docker.sock", "docker", "podman/podman.sock"];

const refuse = (reason: string): PreviewResolution => ({ ok: false, reason });

/** A path as compared: normalised, no trailing slash (`/` stays). */
const cleanPath = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/, "");

function isEngineSocket(path: string | undefined, socket: string): boolean {
  if (path === undefined || path === "") return false;
  const clean = cleanPath(path);
  if (clean === cleanPath(socket)) return true;
  return SOCKET_NAMES.includes(clean.slice(clean.lastIndexOf("/") + 1));
}

/** The host paths that hand an engine to whoever has them mounted. */
function guardedPaths(socket: string, runtimeDir: string | undefined): readonly string[] {
  const rootless = runtimeDir ? ROOTLESS_PATHS.map((p) => posix.join(runtimeDir, p)) : [];
  return [socket, ...DEFAULT_SOCKETS, ...rootless].map(cleanPath);
}

/** Whether mounting the host path `source` brings a guarded path inside it. */
function containsGuarded(source: string | undefined, guarded: readonly string[]): boolean {
  if (source === undefined || source === "") return false;
  const dir = cleanPath(source);
  const prefix = dir === "/" ? dir : `${dir}/`;
  return guarded.some((path) => path === dir || path.startsWith(prefix));
}

/** The host port a binding publishes, or `undefined` when unreadable. */
function hostPortOf(binding: PortBinding): number | undefined {
  const raw = binding.HostPort ?? "";
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : 0;
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** The binding to dial: a wildcard one first, so the ask says what is true. */
function pickBinding(
  bindings: readonly PortBinding[],
): { readonly hostIp: string; readonly hostPort: number } | undefined {
  for (const wanted of [WILDCARD, [LOOPBACK]]) {
    for (const binding of bindings) {
      const hostIp = binding.HostIp ?? "";
      const hostPort = hostPortOf(binding);
      if (wanted.includes(hostIp) && hostPort !== undefined) return { hostIp, hostPort };
    }
  }
  return undefined;
}

export function previewTargetOf(input: PreviewTargetInput): PreviewResolution {
  const { inspect, port, engine, endpoint } = input;
  if (!endpoint.local || endpoint.kind !== "unix") {
    return refuse("the engine is remote: only a container on this host can be shown");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return refuse("the container port must be between 1 and 65535");
  }
  if (typeof inspect.Id !== "string" || inspect.Id === "") {
    return refuse("the engine reported no container id");
  }
  if (inspect.State?.Running !== true) {
    return refuse("the container is not running");
  }
  const host = inspect.HostConfig;
  if (host === undefined || host === null) {
    return refuse("the container's network and privileges cannot be checked");
  }
  if (host.NetworkMode === "host") {
    return refuse("the container uses the host network");
  }
  if (host.Privileged === true) {
    return refuse("the container is privileged");
  }
  const guarded = guardedPaths(endpoint.path, input.runtimeDir);
  for (const mount of inspect.Mounts ?? []) {
    if (
      containsGuarded(mount.Source, guarded) ||
      isEngineSocket(mount.Source, endpoint.path) ||
      isEngineSocket(mount.Destination, endpoint.path)
    ) {
      return refuse("the container mounts the engine socket: whoever drives it controls this host");
    }
  }
  const binding = pickBinding(inspect.NetworkSettings?.Ports?.[`${port}/tcp`] ?? []);
  if (binding === undefined) {
    return refuse(
      `port ${port}/tcp is not published on 127.0.0.1: run the container with -p 127.0.0.1:<host>:${port}`,
    );
  }
  const facts: PreviewFacts = {
    engine,
    endpointLabel: endpointLabel(endpoint),
    id: inspect.Id,
    name: (inspect.Name ?? "").replace(/^\/+/, ""),
    image: inspect.Config?.Image ?? "",
    imageId: inspect.Image ?? "",
    containerPort: port,
    hostPort: binding.hostPort,
    hostIp: binding.hostIp,
  };
  return { ok: true, facts };
}
