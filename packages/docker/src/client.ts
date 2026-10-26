/**
 * `DockerClient` — the container REST verbs + the two exec entry points the
 * runtime needs, over ONE `Dialer`. The client never learns what the dialer is
 * (unix socket, TCP/TLS, ssh stdio in slice A2): that is what makes every
 * transport a single code path (pinned by `client.test.ts`).
 *
 * API version: negotiated once, lazily, from `GET /_ping`'s `Api-Version`
 * header (an unversioned path, like the docker CLI): `min(engine, MAX_API)`,
 * refused below `MIN_API`. Paths are then `/v{version}/…` — Docker and Podman's
 * compat API both serve them.
 */
import type { DuplexChannel } from "@tentacle/transport";
import type { Dialer } from "./byte-duplex.ts";
import { type ExecConn, execChannel } from "./exec-channel.ts";
import { runExec } from "./exec-run.ts";
import {
  type RequestOptions,
  abortError,
  apiError,
  deadline,
  raceSignal,
  request,
} from "./http-conn.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import type {
  ContainerCreateBody,
  ContainerInspect,
  DockerExecTarget,
  ExecChannelOptions,
  RunExecOptions,
  RunExecResult,
} from "./types.ts";

export const MAX_API = "1.52";
export const MIN_API = "1.41";

export interface DockerClientOptions {
  readonly dial: Dialer;
  /** Human label for errors, e.g. `context "desktop-linux" (unix:///…/docker.sock)`. */
  readonly endpointLabel: string;
  /** Pin the API version (skips `_ping` negotiation). */
  readonly apiVersion?: string;
}

export const REMOVE_TIMEOUT_MS = 30_000;

/**
 * Set on every container tentacle creates; `removeContainer` refuses one
 * without it, so a user's container (e.g. the `attach` target) is never deleted.
 */
export const OWNER_LABEL = "tentacle.managed";

export interface RemoveContainerOptions {
  /** Bound for the whole remove (kill + delete). Default 30 s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WaitForRunningOptions {
  /** Default 60000. */
  readonly timeoutMs?: number;
  /** Default 250. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface EngineVersion {
  readonly Version?: string;
  readonly ApiVersion?: string;
  readonly MinAPIVersion?: string;
  readonly Os?: string;
  readonly Arch?: string;
  readonly [key: string]: unknown;
}

/** `"1.52"` → `[1, 52]`; `undefined` when it is not `major.minor`. */
function parseApi(v: string): [number, number] | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function compareApi(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Pick the API version to speak given the engine's, or throw an actionable error. */
export function negotiateApiVersion(engine: string | undefined, label: string): string {
  const parsed = engine === undefined ? undefined : parseApi(engine);
  if (parsed === undefined) {
    throw new Error(
      `the Docker engine at ${label} did not report a usable API version (${engine ?? "none"})`,
    );
  }
  if (compareApi(parsed, parseApi(MIN_API) as [number, number]) < 0) {
    throw new Error(
      `Docker engine API ${engine} at ${label} is older than tentacle supports (≥ ${MIN_API}) — upgrade the engine`,
    );
  }
  return compareApi(parsed, parseApi(MAX_API) as [number, number]) > 0
    ? MAX_API
    : `${parsed[0]}.${parsed[1]}`;
}

const decoder = new TextDecoder();
const json = <T>(res: HttpResponse): T => JSON.parse(decoder.decode(res.body)) as T;

/** `ref` → `fromImage`/`tag` (no tag ⇒ `latest`: the API would otherwise pull EVERY tag). */
export function splitImageRef(ref: string): { fromImage: string; tag?: string } {
  if (ref.includes("@")) {
    return { fromImage: ref }; // a digest pins it
  }
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) {
    return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  }
  return { fromImage: ref, tag: "latest" };
}

export class DockerClient {
  private readonly dial: Dialer;
  private readonly label: string;
  private negotiated: Promise<string> | undefined;
  private readonly conn: ExecConn;

  constructor(options: DockerClientOptions) {
    this.dial = options.dial;
    this.label = options.endpointLabel;
    if (options.apiVersion !== undefined) {
      this.negotiated = Promise.resolve(negotiateApiVersion(options.apiVersion, this.label));
    }
    this.conn = { dial: this.dial, apiPath: () => this.apiPath() };
  }

  /**
   * The `/v1.xx` prefix, negotiated once (a failed negotiation is retried next
   * call). `signal` bounds THIS caller's wait; the shared negotiation keeps its
   * own request timeout, so one caller's abort never fails the others.
   */
  apiPath(signal?: AbortSignal): Promise<string> {
    if (this.negotiated === undefined) {
      const attempt = this.ping().then((p) => negotiateApiVersion(p.apiVersion, this.label));
      this.negotiated = attempt;
      attempt.catch(() => {
        if (this.negotiated === attempt) {
          this.negotiated = undefined;
        }
      });
    }
    const prefix = this.negotiated.then((v) => `/v${v}`);
    return signal ? raceSignal(prefix, signal) : prefix;
  }

  private async call(req: HttpRequest, options?: RequestOptions): Promise<HttpResponse> {
    const res = await request(this.dial, req, options);
    if (res.status === 400) {
      const err = apiError(res);
      if (
        /client version .* is too (old|new)|minimum supported API version/i.test(err.engineMessage)
      ) {
        throw new Error(
          `the Docker engine at ${this.label} refused API ${await this.negotiated}: ${err.engineMessage} — this engine needs a newer tentacle`,
        );
      }
    }
    return res;
  }

  private expect(res: HttpResponse, ok: readonly number[]): HttpResponse {
    if (!ok.includes(res.status)) {
      throw apiError(res);
    }
    return res;
  }

  /** `GET /_ping` (unversioned): liveness + the engine's API version. */
  async ping(signal?: AbortSignal): Promise<{ apiVersion?: string; os?: string }> {
    const res = await request(
      this.dial,
      { method: "GET", path: "/_ping" },
      signal ? { signal } : {},
    );
    this.expect(res, [200]);
    const apiVersion = res.headers.get("api-version");
    const os = res.headers.get("ostype");
    return {
      ...(apiVersion !== undefined ? { apiVersion } : {}),
      ...(os !== undefined ? { os } : {}),
    };
  }

  async version(signal?: AbortSignal): Promise<EngineVersion> {
    const v = await this.apiPath();
    const res = await this.call({ method: "GET", path: `${v}/version` }, signal ? { signal } : {});
    return json<EngineVersion>(this.expect(res, [200]));
  }

  /** Pull `ref`; resolves when the pull finished, rejects on an `{"error":…}` progress line. */
  async pullImage(ref: string, signal?: AbortSignal): Promise<void> {
    const v = await this.apiPath();
    const { fromImage, tag } = splitImageRef(ref);
    const q = new URLSearchParams({ fromImage, ...(tag !== undefined ? { tag } : {}) });
    const res = await this.call(
      { method: "POST", path: `${v}/images/create?${q.toString()}` },
      { timeoutMs: 0, ...(signal ? { signal } : {}) },
    );
    if (res.status !== 200) {
      const err = apiError(res);
      throw new Error(
        `cannot pull ${ref}: ${err.engineMessage || `status ${res.status}`} — check the name, or pull it yourself`,
      );
    }
    for (const line of decoder.decode(res.body).split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: { error?: unknown; errorDetail?: { message?: unknown } };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (typeof parsed.error === "string") {
        throw new Error(
          `cannot pull ${ref}: ${parsed.error} — check the name, or pull it yourself`,
        );
      }
    }
  }

  /** `POST /containers/create?name=` → the new container's id. */
  async createContainer(
    name: string,
    body: ContainerCreateBody,
    signal?: AbortSignal,
  ): Promise<{ id: string; warnings: string[] }> {
    const v = await this.apiPath();
    const labels = {
      ...(body.Labels as Record<string, string> | undefined),
      [OWNER_LABEL]: "true",
    };
    const res = await this.call(
      {
        method: "POST",
        path: `${v}/containers/create?${new URLSearchParams({ name }).toString()}`,
        body: { ...body, Labels: labels },
      },
      signal ? { signal } : {},
    );
    if (res.status === 404) {
      const err = apiError(res);
      throw new Error(
        `cannot create container ${name}: ${err.engineMessage} — pull the image or check its name`,
      );
    }
    const created = json<{ Id: string; Warnings?: string[] | null }>(this.expect(res, [201]));
    return { id: created.Id, warnings: created.Warnings ?? [] };
  }

  /** Start a container; already running (304) is fine. */
  async startContainer(id: string, signal?: AbortSignal): Promise<void> {
    const v = await this.apiPath();
    const res = await this.call(
      { method: "POST", path: `${v}/containers/${encodeURIComponent(id)}/start` },
      signal ? { signal } : {},
    );
    this.expect(res, [204, 304]);
  }

  /** Stop a container (`t` seconds of grace); already stopped (304) is fine. */
  async stopContainer(id: string, graceSeconds = 10, signal?: AbortSignal): Promise<void> {
    const v = await this.apiPath();
    const res = await this.call(
      { method: "POST", path: `${v}/containers/${encodeURIComponent(id)}/stop?t=${graceSeconds}` },
      { timeoutMs: (graceSeconds + 30) * 1000, ...(signal ? { signal } : {}) },
    );
    this.expect(res, [204, 304]);
  }

  async inspectContainer(id: string, signal?: AbortSignal): Promise<ContainerInspect> {
    const v = await this.apiPath();
    const res = await this.call(
      { method: "GET", path: `${v}/containers/${encodeURIComponent(id)}/json` },
      signal ? { signal } : {},
    );
    return json<ContainerInspect>(this.expect(res, [200]));
  }

  /**
   * Remove a container (and its anonymous volumes), fast and bounded on every
   * engine. SIGKILL first: Podman's force-remove otherwise STOPS with the
   * container's stop timeout (10 s when PID 1 ignores SIGTERM), Docker's kills
   * at once — killing first makes both immediate. The kill's HTTP status is not
   * interpreted (already stopped / already gone are fine; engines word them
   * differently): the delete's status decides. Missing (404) is success.
   * Refuses a container without `OWNER_LABEL=true` (one tentacle did not
   * create, e.g. an `attach` target). The whole call — negotiation and connects
   * included — is bounded by `timeoutMs` (default 30 s).
   */
  async removeContainer(id: string, options: RemoveContainerOptions = {}): Promise<void> {
    // ONE deadline for everything — the version negotiation, every connect,
    // every request (Review F1); the requests themselves get no separate timer.
    const budget = options.timeoutMs ?? REMOVE_TIMEOUT_MS;
    const life = deadline(budget, options.signal);
    const opts: RequestOptions = { signal: life.signal, timeoutMs: 0 };
    try {
      const v = await this.apiPath(life.signal);
      const path = `${v}/containers/${encodeURIComponent(id)}`;
      // Ownership guard (Review F2): only a container tentacle created is ever removed.
      const info = await this.call({ method: "GET", path: `${path}/json` }, opts);
      if (info.status === 404) {
        return; // already gone: idempotent
      }
      const labels = json<ContainerInspect>(this.expect(info, [200])).Config?.Labels;
      if (labels?.[OWNER_LABEL] !== "true") {
        throw new Error(
          `refusing to remove container "${id}": it was not created by tentacle (no ${OWNER_LABEL}=true label)`,
        );
      }
      await this.call({ method: "POST", path: `${path}/kill?signal=KILL` }, opts);
      const res = await this.call({ method: "DELETE", path: `${path}?force=true&v=true` }, opts);
      this.expect(res, [204, 404]);
    } catch (error) {
      if (life.expired()) {
        throw new Error(`removing container "${id}" timed out after ${budget}ms`);
      }
      throw error;
    } finally {
      life.dispose();
    }
  }

  /**
   * Poll until the container is running, or reject: it exited/died (it never
   * will be), the timeout elapsed, or the signal aborted.
   */
  async waitForRunning(id: string, options: WaitForRunningOptions = {}): Promise<ContainerInspect> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.inspectContainer(id, options.signal);
      const state = info.State;
      if (state?.Running) {
        return info;
      }
      if (state?.Status === "exited" || state?.Status === "dead") {
        const why = state.Error ? `: ${state.Error}` : state.OOMKilled ? " (OOM-killed)" : "";
        throw new Error(
          `container ${id} ${state.Status} with code ${state.ExitCode ?? "?"} before running${why}`,
        );
      }
      if (Date.now() + intervalMs > deadline) {
        throw new Error(
          `container ${id} was not running within ${timeoutMs}ms (state ${state?.Status ?? "unknown"})`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(abortError());
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort); // no listener left behind (Review F4)
          resolve();
        }, intervalMs);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  /** Exec `target` as the `DuplexChannel` an `RpcPeer` rides (returns at once). */
  openExec(target: DockerExecTarget, options: ExecChannelOptions = {}): DuplexChannel {
    return execChannel(this.conn, target, options);
  }

  /** Run a one-shot command; resolves on its exit with the real exit code. */
  runExec(
    target: DockerExecTarget,
    input?: Uint8Array,
    options?: RunExecOptions,
  ): Promise<RunExecResult> {
    return runExec(this.conn, target, input, options);
  }
}
