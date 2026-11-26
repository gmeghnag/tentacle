/**
 * The serve's tunnel of ONE shared port
 * (docs/feat/session-apps-container-ports.md S3): dialled OUT to the apps host
 * with a fresh signature each time, reconnected with backoff while the share
 * lives, ended when the host says the app is over. Stopping it unpublishes.
 * Logs hold an app id and a reason: never a path, a header or a secret.
 */
import type { PreviewRefusal } from "@tentacle/core";
import {
  APPS_TUNNEL_CLOSE,
  APPS_TUNNEL_PING_MS,
  type TunnelFrame,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from "@tentacle/protocol";
import { AppsClient, type LiveAppsApi } from "./apps-client.ts";
import { loadOrCreateAppsKey } from "./apps-key.ts";
import type { CreatedShare, RunningShare, ShareHooks, ShareStarter } from "./session-previews.ts";
import { ShareStream } from "./share-stream.ts";

/** Requests of one app at once, as a bound on a host that opens too many. */
const MAX_STREAMS = 256;

/** The host's words that mean the app will never serve again. */
const OVER: ReadonlySet<string> = new Set([
  "expired",
  "deleted",
  "taken_down",
  "forbidden",
  "blocked",
  "not_found",
]);

export interface ShareTimings {
  readonly backoffMinMs?: number;
  readonly backoffMaxMs?: number;
  readonly connectTimeoutMs?: number;
  readonly pingMs?: number;
}

export interface ShareTunnelDeps extends ShareTimings {
  readonly api: LiveAppsApi;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly log?: (line: string) => void;
}

/** The tunnel socket as Bun gives it. */
interface TunnelSocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  addEventListener(kind: "pong", listener: () => void): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export class ShareTunnel implements RunningShare {
  private socket: TunnelSocket | undefined;
  private readonly streams = new Map<number, ShareStream>();
  /** The highest stream id this socket opened: the host's ids only grow. */
  private last = 0;
  private stopped: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;

  constructor(
    private readonly app: { readonly id: string; readonly origin: string },
    private readonly hooks: ShareHooks,
    private readonly deps: ShareTunnelDeps,
  ) {
    this.backoff = deps.backoffMinMs ?? 1000;
    void this.dial();
  }

  stop(): Promise<void> {
    this.stopped ??= (async () => {
      clearTimeout(this.retry);
      this.drop();
      const removed = await this.deps.api.remove(this.app.id);
      // Unreachable: the host's lease ends it (the tunnel is gone already).
      this.deps.log?.(`share ${this.app.id} removed ${removed.ok ? "ok" : removed.code}`);
    })().catch(() => {});
    return this.stopped;
  }

  /** Close the socket and its streams, saying nothing more about it. */
  private drop(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.endStreams();
    socket?.close(APPS_TUNNEL_CLOSE.normal);
  }

  private endStreams(): void {
    for (const stream of [...this.streams.values()]) {
      stream.finish();
    }
    this.streams.clear();
    this.last = 0;
  }

  private async dial(): Promise<void> {
    let target: Awaited<ReturnType<LiveAppsApi["signTunnel"]>>;
    try {
      target = await this.deps.api.signTunnel(this.app.id);
    } catch {
      this.later();
      return;
    }
    if (this.stopped !== undefined) return;
    const Socket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => TunnelSocket;
    let socket: TunnelSocket;
    try {
      socket = new Socket(target.url, { headers: target.headers });
    } catch {
      this.later();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    let answered = true;
    let pinger: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => socket.terminate(), this.deps.connectTimeoutMs ?? 15_000);
    socket.onopen = () => {
      clearTimeout(deadline);
      if (this.socket !== socket) return;
      opened = true;
      this.backoff = this.deps.backoffMinMs ?? 1000;
      this.hooks.onState("up");
      // A host that stopped answering (a laptop's sleep) is dialled again.
      pinger = setInterval(() => {
        if (!answered) {
          socket.terminate();
          return;
        }
        answered = false;
        socket.ping();
      }, this.deps.pingMs ?? APPS_TUNNEL_PING_MS);
    };
    socket.addEventListener("pong", () => {
      answered = true;
    });
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      answered = true;
      const frame =
        typeof event.data === "string"
          ? undefined
          : decodeTunnelFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame === undefined || !this.receive(frame)) {
        socket.close(APPS_TUNNEL_CLOSE.protocol, "protocol");
        // Not waiting for the close handshake: this socket is over.
        this.closed(socket, APPS_TUNNEL_CLOSE.protocol, "protocol", true);
      }
    };
    socket.onclose = (event) => {
      clearTimeout(deadline);
      clearInterval(pinger);
      this.closed(socket, event.code, event.reason, opened);
    };
  }

  private closed(socket: TunnelSocket, code: number, reason: string, opened: boolean): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.endStreams();
    const said = code === APPS_TUNNEL_CLOSE.refused || code === APPS_TUNNEL_CLOSE.ended;
    this.deps.log?.(`share ${this.app.id} tunnel closed ${code}${said ? ` ${reason}` : ""}`);
    if (said && OVER.has(reason)) {
      this.hooks.onEnded(reason);
      return;
    }
    this.hooks.onState("down");
    if (opened) {
      this.later();
    } else {
      void this.explain();
    }
  }

  /** An upgrade that got no answer in words: ask for them, then retry. */
  private async explain(): Promise<void> {
    const probed = await this.deps.api.probeTunnel(this.app.id).catch(() => undefined);
    if (this.stopped !== undefined) return;
    if (probed !== undefined && !probed.ok && OVER.has(probed.code)) {
      this.hooks.onEnded(probed.code);
      return;
    }
    this.later();
  }

  private later(): void {
    if (this.stopped !== undefined) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.dial(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.deps.backoffMaxMs ?? 30_000);
  }

  /** `false`: the frame breaks the protocol. */
  private receive(frame: TunnelFrame): boolean {
    if (frame.type !== "open") {
      if (frame.stream > this.last) return false;
      // A finished stream's late frame crossed our answer on the wire.
      return this.streams.get(frame.stream)?.receive(frame) ?? true;
    }
    if (frame.stream <= this.last) return false;
    this.last = frame.stream;
    if (this.streams.size >= MAX_STREAMS) {
      this.send({ type: "reset", stream: frame.stream, reason: "too many requests at once" });
      return true;
    }
    const stream = new ShareStream(frame.stream, frame.request, {
      secret: this.hooks.secret,
      publicOrigin: this.app.origin,
      connect: this.hooks.connect,
      send: (out) => this.send(out),
      done: (id) => this.streams.delete(id),
      fetch: this.deps.fetch ?? ((url, init) => fetch(url, init)),
    });
    this.streams.set(frame.stream, stream);
    void stream.run();
    return true;
  }

  private send(frame: TunnelFrame): boolean {
    const bytes = encodeTunnelFrame(frame);
    if (bytes === undefined || this.socket === undefined) return false;
    this.socket.send(bytes);
    return true;
  }
}

/** A share starter over an apps API (the tests' seam). */
export function shareStarterOf(
  domain: string,
  api: () => Promise<LiveAppsApi | { readonly reason: string }>,
  deps: Omit<ShareTunnelDeps, "api"> = {},
): ShareStarter {
  /** The running tunnels: the daemon's stop ends them all. */
  const running = new Set<ShareTunnel>();
  let closed = false;
  const stopping = "the daemon is stopping";
  return {
    domain,
    async close() {
      closed = true;
      const tunnels = [...running];
      running.clear();
      await Promise.all(tunnels.map((tunnel) => tunnel.stop()));
    },
    async create(signal): Promise<CreatedShare | PreviewRefusal> {
      if (closed) return { ok: false, reason: stopping };
      const live = await api();
      if ("reason" in live) return { ok: false, reason: live.reason };
      const created = await live.createLive(signal);
      if (!created.ok) {
        const why = created.reason === undefined ? "" : `: ${created.reason}`;
        return {
          ok: false,
          reason: `the apps host refused (${created.code}): ${created.message}${why}`,
        };
      }
      const { id, url } = created.lease;
      const app = { id, origin: new URL(url).origin };
      if (closed) {
        await live.remove(id);
        return { ok: false, reason: stopping };
      }
      return {
        ok: true,
        url,
        open: (hooks) => {
          const tunnel = new ShareTunnel(app, hooks, { ...deps, api: live });
          running.add(tunnel);
          return {
            stop: () => {
              running.delete(tunnel);
              return tunnel.stop();
            },
          };
        },
        discard: async () => {
          await live.remove(id);
        },
      };
    },
  };
}

/**
 * `TENTACLE_APPS_URL`: where to dial the apps host INSTEAD of
 * `https://<domain>` — for a local test only, so a loopback `http://` and
 * nothing else. `undefined`: unset or refused.
 */
export function loopbackAppsUrl(value: string | undefined): string | undefined {
  return value !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(value)
    ? value
    : undefined;
}

/** A `serve`'s way to the apps host: the key is loaded at the first share. */
export function createShareStarter(options: {
  readonly configDir: string;
  readonly domain: string;
  readonly baseUrl?: string | undefined;
  readonly log?: (line: string) => void;
}): ShareStarter {
  let client: AppsClient | undefined;
  return shareStarterOf(
    options.domain,
    async () => {
      if (client === undefined) {
        const key = await loadOrCreateAppsKey(options.configDir);
        if (!key.ok) return { reason: `the publisher key cannot be used: ${key.reason}` };
        client ??= new AppsClient({
          domain: options.domain,
          key: key.key,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        });
      }
      return client;
    },
    options.log === undefined ? {} : { log: options.log },
  );
}
