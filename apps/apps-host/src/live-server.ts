/**
 * The socket side of live apps (docs/feat/session-apps-container-ports.md S1):
 * the signed tunnel upgrade, the visitor's requests and WebSockets carried over
 * it, and what time and the operator do to a connected tunnel. Decisions are
 * `HostCore`'s and `pages.ts`'s. Logs hold an id, a status, bytes and a reason:
 * never a path, a query or a header.
 */
import {
  APPS_HEADERS,
  APPS_TUNNEL_CLOSE,
  APPS_TUNNEL_MAX_FRAME_BYTES,
  type AppsErrorCode,
  type TunnelRequest,
} from "@tentacle/protocol";
import { limiterKeyOf } from "@tentacle/relay/client-ip";
import type { HostCore, View } from "./host-core.ts";
import type { AppsLimits } from "./limits.ts";
import { type LiveStream, type VisitorSocket, closeReason } from "./live-stream.ts";
import { LiveTunnels, type Tunnel } from "./live-tunnels.ts";
import { type Pages, liveRequestHeaders, liveResponseHeaders, liveVisitorGate } from "./pages.ts";
import { NOTICE_STATUS, type Refused, pageResponse, text } from "./respond.ts";
import { type NonceGuard, checkSignedHeaders, verifySignedBody } from "./signed-request.ts";

export type SocketData =
  | {
      readonly kind: "tunnel";
      readonly app: string;
      readonly key: string;
      /** Why the host will not serve it: said in the close frame. */
      readonly refusal?: AppsErrorCode;
      tunnel?: Tunnel;
    }
  | { readonly kind: "visitor"; readonly stream: LiveStream };

/** What is used of Bun's server and server socket. */
export interface LiveUpgrader {
  upgrade(req: Request, options: { data: SocketData; headers?: Record<string, string> }): boolean;
  timeout(req: Request, seconds: number): void;
}

export interface LiveSocket {
  readonly data: SocketData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  ping(): void;
}

/** Bytes a socket may buffer: every stream's window fits well inside. */
const BACKPRESSURE_BYTES = 128 * 1024 * 1024;
const ROBOTS = "User-agent: *\nDisallow: /\n";
/** A response that has no body, whatever the publisher sends. */
const NO_BODY = new Set([204, 205, 304]);

/** What a connected tunnel is told when its app may no longer be reached. */
const ENDED: Record<Exclude<View["kind"], "live" | "over_limit">, AppsErrorCode> = {
  maintenance: "killed",
  taken_down: "taken_down",
  deleted: "deleted",
  offline: "expired",
  unknown: "not_found",
  app: "not_found",
};

export interface LiveOptions {
  readonly domain: string;
  readonly limits: AppsLimits;
  readonly now: () => number;
  readonly core: HostCore;
  readonly pages: Pages;
  readonly nonces: NonceGuard;
  /** Nothing signed before this is accepted (the nonce cache started empty). */
  readonly startedAt: () => number;
  readonly log: (line: string) => void;
}

export function createLive(options: LiveOptions) {
  const { core, pages, domain, log } = options;
  const tunnels = new LiveTunnels({
    limits: options.limits,
    now: options.now,
    count: (app, bytes) => core.countLive(app, bytes),
    onDropped: (app, why) => {
      // The lease runs from the moment the publisher was last there.
      core.keepAlive(app);
      log(`tunnel-closed ${app} ${why}`);
    },
    onDone: (app, status, bytes) => log(`live ${app} ${status ?? "-"} bytes ${bytes}`),
  });

  /** The signed upgrade. `undefined`: upgraded (a refusal is said on the socket). */
  const upgrade = async (
    id: string,
    req: Request,
    url: { readonly pathname: string; readonly search: string },
    ip: string,
    server: LiveUpgrader,
  ): Promise<Response | Refused | undefined> => {
    const claim = { key: req.headers.get(APPS_HEADERS.key) ?? "", id };
    const early = core.admitApi(limiterKeyOf(ip), claim);
    if (!early.ok) return early;
    if (url.search !== "" || req.url.includes("?")) {
      return { error: "bad_request", message: "the API takes no query" };
    }
    const shape = checkSignedHeaders(req.headers, {
      now: options.now(),
      startedAt: options.startedAt(),
      skewMs: options.limits.skewMs,
    });
    if (!shape.ok) return shape;
    const renewing = core.renewable(claim);
    const verified = await verifySignedBody(shape.request, {
      method: req.method,
      path: url.pathname,
      domain,
      body: new Uint8Array(),
      nonces: options.nonces,
      now: options.now(),
      ...(renewing ? { reserveFor: id } : {}),
    });
    if (!verified.ok) return verified;
    const { key } = shape.request;
    const signer = core.admitSigned(key, renewing);
    const verdict = signer.ok ? core.admitTunnel({ key, id }, tunnels.others(id)) : signer;
    const data: SocketData = {
      kind: "tunnel",
      app: id,
      key,
      ...(verdict.ok ? {} : { refusal: verdict.error }),
    };
    if (server.upgrade(req, { data })) return undefined;
    return verdict.ok
      ? { error: "bad_request", message: "this call is a WebSocket upgrade" }
      : verdict;
  };

  /** A visitor of a live app. `undefined`: upgraded to a WebSocket. */
  const visit = async (
    id: string,
    req: Request,
    url: { readonly pathname: string; readonly search: string },
    ip: string,
    server: LiveUpgrader,
  ): Promise<Response | undefined> => {
    const view = core.view(id);
    if (view.kind !== "live") {
      const kind = view.kind === "app" ? "unknown" : view.kind;
      return pageResponse(pages.notice(kind), NOTICE_STATUS[kind]);
    }
    if (url.pathname === "/robots.txt") return text(ROBOTS);
    const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const target = `${url.pathname}${url.search}`;
    const gate = liveVisitorGate(req.headers, {
      method: req.method,
      upgrade: websocket,
      origin: `https://${id}.${domain}`,
    });
    if (gate === "warning") return pageResponse(pages.liveWarning(id, target));
    if (gate === "forbidden") return text("forbidden", 403);
    const rate = core.admitLive(limiterKeyOf(ip));
    if (!rate.ok) {
      return text("too many requests", 429, {
        "Retry-After": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)),
      });
    }
    const headers: [string, string][] = [];
    req.headers.forEach((value, name) => {
      headers.push([name, value]);
    });
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol !== "");
    const request: TunnelRequest = {
      method: req.method,
      target,
      headers: liveRequestHeaders(headers),
      ...(websocket ? { ws: { protocols } } : {}),
    };
    const opened = tunnels.open(id, request);
    if (!opened.ok) {
      if (opened.why === "offline") {
        return pageResponse(pages.notice("offline"), NOTICE_STATUS.offline);
      }
      return opened.why === "busy"
        ? text("the app is busy", 503, { "Retry-After": "1" })
        : text("the request headers are too large", 431);
    }
    const { stream } = opened;
    // The tunnel's own idle timer bounds the stream, not the server's.
    server.timeout(req, 0);
    req.signal.addEventListener("abort", () => stream.reset("the visitor left"), { once: true });
    if (!websocket) {
      if (req.body === null || req.method === "GET" || req.method === "HEAD") {
        stream.endRequest();
      } else {
        void pump(req.body, stream);
      }
    }
    const head = await stream.head;
    if (!head.ok) {
      if (head.why === "over_limit") {
        return pageResponse(pages.notice("over_limit"), NOTICE_STATUS.over_limit);
      }
      return head.why === "timeout"
        ? text("the app did not answer in time", 504)
        : text("the app could not be reached", 502);
    }
    const { status, protocol } = head.response;
    const bad = (): Response => {
      stream.reset("a response the host cannot send");
      return text("the app could not be reached", 502);
    };
    if (websocket && status === 101) {
      if (protocol !== undefined && !protocols.includes(protocol)) return bad();
      const upgraded = server.upgrade(req, {
        data: { kind: "visitor", stream },
        // Bun refuses an empty `headers` object: only when there is one.
        ...(protocol === undefined ? {} : { headers: { "Sec-WebSocket-Protocol": protocol } }),
      });
      return upgraded ? undefined : bad();
    }
    if (status < 200) return bad();
    const bodyless = websocket || req.method === "HEAD" || NO_BODY.has(status);
    try {
      const response = new Response(bodyless ? null : stream.body(), {
        status,
        headers: liveResponseHeaders(head.response.headers, req.method === "HEAD"),
      });
      // A refused handshake has no body to wait for.
      if (websocket) stream.reset("the handshake was refused");
      return response;
    } catch {
      return bad();
    }
  };

  const socket = (ws: LiveSocket): VisitorSocket => ({
    send(message) {
      const sent = ws.send(message);
      if (sent === -1) return "backpressure";
      return sent === 0 && message.length > 0 ? "dropped" : "sent";
    },
    close: (code, reason) => ws.close(code, closeReason(reason)),
  });

  const socketOptions = {
    maxPayloadLength: APPS_TUNNEL_MAX_FRAME_BYTES,
    backpressureLimit: BACKPRESSURE_BYTES,
    idleTimeout: 120,
    sendPings: true,
  };

  const websocket = {
    open(ws: LiveSocket): void {
      const { data } = ws;
      if (data.kind === "visitor") {
        data.stream.bind(socket(ws));
        return;
      }
      // Asked again: the cap may have filled between the upgrade and here.
      const verdict =
        data.refusal === undefined
          ? core.admitTunnel({ key: data.key, id: data.app }, tunnels.others(data.app))
          : ({ ok: false, error: data.refusal } as const);
      if (!verdict.ok) {
        log(`tunnel-refused ${data.app} ${verdict.error}`);
        ws.close(APPS_TUNNEL_CLOSE.refused, verdict.error);
        return;
      }
      data.tunnel = tunnels.attach(data.app, {
        send: (bytes) => ws.send(bytes) !== 0,
        close: (code, reason) => ws.close(code, closeReason(reason)),
        ping: () => ws.ping(),
      });
      core.keepAlive(data.app);
      log(`tunnel-open ${data.app} key ${data.key.slice(0, 8)}`);
    },
    message(ws: LiveSocket, message: string | Buffer): void {
      const { data } = ws;
      if (data.kind === "visitor") {
        data.stream.fromVisitor(typeof message === "string" ? message : new Uint8Array(message));
        return;
      }
      if (data.tunnel === undefined) return;
      if (typeof message === "string") {
        tunnels.violation(data.tunnel);
      } else {
        tunnels.receive(data.tunnel, new Uint8Array(message));
      }
    },
    drain(ws: LiveSocket): void {
      if (ws.data.kind === "visitor") ws.data.stream.drained();
    },
    close(ws: LiveSocket, code: number, reason: string): void {
      const { data } = ws;
      if (data.kind === "visitor") {
        data.stream.visitorClosed(code, reason);
      } else if (data.tunnel !== undefined) {
        tunnels.detach(data.tunnel);
      }
    },
  };

  return {
    tunnels,
    upgrade,
    visit,
    websocket,
    socketOptions,
    /** Before the core's sweep: a connected tunnel keeps its app's lease. */
    keepConnected(): void {
      for (const app of tunnels.apps()) {
        core.keepAlive(app);
      }
    },
    /** After it: close what may no longer be reached, reset what stalled. */
    sweep(): void {
      for (const app of tunnels.apps()) {
        const view = core.view(app);
        if (view.kind !== "live" && view.kind !== "over_limit") {
          const reason = ENDED[view.kind];
          log(`tunnel-ended ${app} ${reason}`);
          tunnels.end(app, reason);
        }
      }
      tunnels.sweepIdle();
    },
  };
}

/** Carry a request body into its stream, as fast as the window allows. */
async function pump(body: ReadableStream<Uint8Array>, stream: LiveStream): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        stream.endRequest();
        return;
      }
      if (!(await stream.sendData(value))) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    stream.reset("the request body failed");
  }
}
