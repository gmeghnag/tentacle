/**
 * The connected tunnels of live apps and their streams
 * (docs/feat/session-apps-container-ports.md): one tunnel per app, the newest
 * wins. Only the host opens streams. Anything a tunnel sends that breaks the
 * protocol closes it; a frame for a stream already finished is ignored (it
 * crossed our reset on the wire). What may connect is `HostCore`'s decision.
 */
import {
  APPS_TUNNEL_CLOSE,
  type AppsErrorCode,
  type TunnelFrame,
  type TunnelRequest,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from "@tentacle/protocol";
import type { AppsLimits } from "./limits.ts";
import { LiveStream } from "./live-stream.ts";

/** The publisher's WebSocket, as the registry drives it. */
export interface TunnelSocket {
  /** `false`: the socket dropped the bytes. */
  send(bytes: Uint8Array): boolean;
  close(code: number, reason: string): void;
  ping(): void;
}

export interface Tunnel {
  readonly app: string;
  readonly socket: TunnelSocket;
}

interface Connected extends Tunnel {
  readonly streams: Map<number, LiveStream>;
  /** The highest stream id opened: ids grow, so a lower unknown one is over. */
  last: number;
}

export type Opened =
  | { readonly ok: true; readonly stream: LiveStream }
  | { readonly ok: false; readonly why: "offline" | "busy" | "too_large" };

export interface LiveTunnelsOptions {
  readonly limits: Pick<AppsLimits, "maxStreamsPerApp" | "maxLiveStreams" | "liveStreamIdleMs">;
  readonly now: () => number;
  /** Count an app's bytes. `false`: over its daily budget. */
  readonly count: (app: string, bytes: number) => boolean;
  /** A tunnel that was current is gone because its publisher left (or misbehaved). */
  readonly onDropped: (app: string, why: "closed" | "protocol") => void;
  /** A stream finished: its status (if a head came) and the bytes both ways. */
  readonly onDone: (app: string, status: number | undefined, bytes: number) => void;
}

export class LiveTunnels {
  private readonly tunnels = new Map<string, Connected>();
  private streams = 0;

  constructor(private readonly options: LiveTunnelsOptions) {}

  has(app: string): boolean {
    return this.tunnels.has(app);
  }

  apps(): string[] {
    return [...this.tunnels.keys()];
  }

  /** The tunnels of apps other than `app`. */
  others(app: string): number {
    return this.tunnels.size - (this.tunnels.has(app) ? 1 : 0);
  }

  /** The newest tunnel of an app replaces the old one (a half-open socket). */
  attach(app: string, socket: TunnelSocket): Tunnel {
    const old = this.tunnels.get(app);
    if (old !== undefined) {
      this.drop(old, APPS_TUNNEL_CLOSE.replaced, "replaced");
    }
    const tunnel: Connected = { app, socket, streams: new Map(), last: 0 };
    this.tunnels.set(app, tunnel);
    return tunnel;
  }

  /** The publisher's socket closed. */
  detach(tunnel: Tunnel): void {
    const current = this.tunnels.get(tunnel.app);
    if (current !== tunnel) return;
    this.forget(current);
    this.options.onDropped(tunnel.app, "closed");
  }

  /** The host ends an app's tunnel (a takedown, the kill switch, an expiry). */
  end(app: string, reason: AppsErrorCode): boolean {
    const tunnel = this.tunnels.get(app);
    if (tunnel === undefined) return false;
    this.drop(tunnel, APPS_TUNNEL_CLOSE.ended, reason);
    return true;
  }

  /** A binary message of a tunnel. */
  receive(from: Tunnel, message: Uint8Array): void {
    const tunnel = this.tunnels.get(from.app);
    // A replaced or ended tunnel has nothing more to say.
    if (tunnel !== from) return;
    const frame = decodeTunnelFrame(message);
    if (frame === undefined || frame.type === "open" || frame.stream > tunnel.last) {
      this.violated(tunnel);
      return;
    }
    const stream = tunnel.streams.get(frame.stream);
    if (stream !== undefined && !stream.receive(frame)) {
      this.violated(tunnel);
    }
  }

  /** A message that is not binary: not of this protocol. */
  violation(from: Tunnel): void {
    const tunnel = this.tunnels.get(from.app);
    if (tunnel === from) this.violated(tunnel);
  }

  open(app: string, request: TunnelRequest): Opened {
    const tunnel = this.tunnels.get(app);
    if (tunnel === undefined) return { ok: false, why: "offline" };
    const { maxStreamsPerApp, maxLiveStreams } = this.options.limits;
    if (tunnel.streams.size >= maxStreamsPerApp || this.streams >= maxLiveStreams) {
      return { ok: false, why: "busy" };
    }
    const id = tunnel.last + 1;
    const open: TunnelFrame = { type: "open", stream: id, request };
    const bytes = encodeTunnelFrame(open);
    if (bytes === undefined) return { ok: false, why: "too_large" };
    const stream = new LiveStream(id, request.ws !== undefined, {
      send: (frame) => this.send(tunnel, frame),
      count: (n) => this.options.count(app, n),
      overLimit: () => this.resetApp(app),
      done: (done, status, total) => {
        if (tunnel.streams.delete(done)) this.streams -= 1;
        this.options.onDone(app, status, total);
      },
      now: this.options.now,
    });
    tunnel.last = id;
    tunnel.streams.set(id, stream);
    this.streams += 1;
    if (!tunnel.socket.send(bytes)) {
      this.violated(tunnel);
      return { ok: false, why: "offline" };
    }
    return { ok: true, stream };
  }

  /** Reset every stream of an app (over its daily budget). */
  private resetApp(app: string): void {
    for (const stream of [...(this.tunnels.get(app)?.streams.values() ?? [])]) {
      stream.reset("over the daily limit", "over_limit");
    }
  }

  /** Reset HTTP streams with no bytes for too long (a WebSocket is pinged). */
  sweepIdle(): void {
    const cutoff = this.options.now() - this.options.limits.liveStreamIdleMs;
    for (const tunnel of this.tunnels.values()) {
      for (const stream of [...tunnel.streams.values()]) {
        if (!stream.websocket && stream.lastActivity < cutoff) {
          stream.reset("idle", "timeout");
        }
      }
    }
  }

  ping(): void {
    for (const tunnel of this.tunnels.values()) {
      tunnel.socket.ping();
    }
  }

  closeAll(): void {
    for (const tunnel of [...this.tunnels.values()]) {
      this.drop(tunnel, APPS_TUNNEL_CLOSE.normal, "the host is stopping");
    }
  }

  private send(tunnel: Connected, frame: TunnelFrame): void {
    if (this.tunnels.get(tunnel.app) !== tunnel) return;
    const bytes = encodeTunnelFrame(frame);
    // A dropped frame would corrupt its stream: the tunnel cannot go on.
    if (bytes === undefined || !tunnel.socket.send(bytes)) this.violated(tunnel);
  }

  private violated(tunnel: Connected): void {
    this.drop(tunnel, APPS_TUNNEL_CLOSE.protocol, "protocol");
    this.options.onDropped(tunnel.app, "protocol");
  }

  private forget(tunnel: Connected): void {
    this.tunnels.delete(tunnel.app);
    for (const stream of [...tunnel.streams.values()]) {
      stream.fail("gone");
    }
  }

  private drop(tunnel: Connected, code: number, reason: string): void {
    // Forgotten first: nothing a failing stream does reaches the socket again.
    this.forget(tunnel);
    tunnel.socket.close(code, reason);
  }
}
