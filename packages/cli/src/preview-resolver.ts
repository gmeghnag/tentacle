/**
 * The engine side of a `serve`'s container previews
 * (docs/feat/container-apps-devices.md Design 1/4): the endpoint resolved from
 * the serve's OWN env, a remote one refused before any request, one fresh
 * inspect per call (nothing cached), the rules in `previewTargetOf`. Built here
 * and injected: the daemon does not depend on `@tentacle/docker`.
 */
import type { PreviewEngine, PreviewResolution, PreviewResolver } from "@tentacle/core";
import {
  type ContainerInspect,
  DockerApiError,
  DockerClient,
  type EngineEndpoint,
  dialerFor,
  endpointLabel,
  previewTargetOf,
  resolveEngineEndpoint,
  resolvePodmanEndpoint,
} from "@tentacle/docker";
import { type EngineHostIO, defaultEngineHostIO } from "./engine-select.ts";

export type PreviewEngineIO = Pick<
  EngineHostIO,
  "env" | "platform" | "uid" | "tmpdir" | "homeDir" | "readFile" | "exists" | "listDir"
> & {
  readonly inspect: (endpoint: EngineEndpoint, id: string) => Promise<ContainerInspect>;
};

const INSPECT_TIMEOUT_MS = 10_000;
/** The engines' own container-name rule (an id matches it too): never a path. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function defaultPreviewEngineIO(): PreviewEngineIO {
  return {
    ...defaultEngineHostIO(),
    inspect: (endpoint, id) =>
      new DockerClient({
        dial: dialerFor(endpoint),
        endpointLabel: endpointLabel(endpoint),
      }).inspectContainer(id, AbortSignal.timeout(INSPECT_TIMEOUT_MS)),
  };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function endpointOf(io: PreviewEngineIO, engine: PreviewEngine): EngineEndpoint {
  if (engine === "docker") {
    return resolveEngineEndpoint({ env: io.env, homeDir: io.homeDir, readFile: io.readFile });
  }
  return resolvePodmanEndpoint({
    env: io.env,
    platform: io.platform,
    ...(io.uid !== undefined ? { uid: io.uid } : {}),
    tmpdir: io.tmpdir,
    homeDir: io.homeDir,
    exists: io.exists,
    listDir: io.listDir,
    readFile: io.readFile,
  });
}

export function enginePreviewResolver(
  io: PreviewEngineIO = defaultPreviewEngineIO(),
): PreviewResolver {
  const look = async (
    engine: PreviewEngine,
    container: string,
    port: number,
    scope: "link" | undefined,
  ): Promise<PreviewResolution> => {
    if (!CONTAINER_NAME.test(container)) {
      return { ok: false, reason: "that is not a container name or id" };
    }
    let endpoint: EngineEndpoint;
    try {
      endpoint = endpointOf(io, engine);
    } catch (error) {
      return { ok: false, transient: true, reason: `no ${engine} engine: ${message(error)}` };
    }
    // Never even asked: only an engine on this host can be shown.
    if (!endpoint.local) {
      return {
        ok: false,
        reason: `the ${engine} engine is remote (${endpointLabel(endpoint)}): only a container on this host can be shown`,
      };
    }
    let inspect: ContainerInspect;
    try {
      inspect = await io.inspect(endpoint, container);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return { ok: false, reason: `no such ${engine} container` };
      }
      return { ok: false, transient: true, reason: message(error) };
    }
    const runtimeDir = io.env.XDG_RUNTIME_DIR;
    return previewTargetOf({ inspect, port, engine, endpoint, runtimeDir, scope });
  };

  return {
    prepare: (request) => look(request.engine, request.container, request.port, request.scope),
    // A shared row is re-checked by the internet's rules on every dial.
    resolve: async (row) =>
      row.engine === "docker" || row.engine === "podman"
        ? look(row.engine, row.containerId, row.containerPort, row.link ? "link" : undefined)
        : { ok: false, reason: "unknown engine" },
  };
}
