/**
 * The strip-origin proxy's socket half (docs/feat/mobile-app-shell.md, Owner Q4).
 * `stripOrigin` does the rewrite (pure, tested); this listens on an ephemeral
 * port, removes the `Origin:` line from an upgrade request's head, and then
 * pipes raw bytes BOTH ways — the WebSocket frame that follows is opaque to it.
 *
 * TEST-ONLY: nothing in the app imports this file.
 */
import { Buffer } from "node:buffer";
import { type Socket, connect, createServer } from "node:net";
import { headEnd, stripOrigin } from "./strip-origin.ts";

export interface StripOriginProxy {
  /** `127.0.0.1:<port>` — what a Release build's `EXPO_PUBLIC_TENTACLE_URL` names. */
  readonly address: string;
  /** The Origin values it removed, in order (evidence for the run's log). */
  readonly stripped: readonly string[];
  /** Resolves once the listener is bound, so `address` is real. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

export interface StripOriginProxyOptions {
  /** The real daemon's `host:port` that upgrades are forwarded to. */
  readonly upstream: { readonly host: string; readonly port: number };
}

/** Split an upstream `host:port` (`127.0.0.1:4100`). */
export function parseUpstream(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(":");
  if (at <= 0) {
    throw new Error(`upstream must be host:port (got ${JSON.stringify(address)})`);
  }
  return { host: address.slice(0, at), port: Number(address.slice(at + 1)) };
}

/** `write` accepts a typed array; a Buffer is one at runtime. */
function bytes(buffer: Buffer): Uint8Array {
  return buffer as unknown as Uint8Array;
}

/**
 * Start the proxy on an ephemeral port. The first chunks of a connection are
 * buffered until the head's blank line arrives (a head may span chunks), then
 * rewritten and forwarded; everything after it passes through untouched, and so
 * does everything upstream sends back.
 */
export function startStripOriginProxy(options: StripOriginProxyOptions): StripOriginProxy {
  const stripped: string[] = [];
  const live = new Set<Socket>();
  let ready: () => void = () => {};
  const bound = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const server = createServer((client) => {
    live.add(client);
    let pending: Buffer = Buffer.alloc(0);
    let upstream: Socket | null = null;

    client.on("error", () => {
      client.destroy();
    });
    client.on("data", (chunk: Buffer) => {
      if (upstream !== null) {
        upstream.write(bytes(chunk));
        return;
      }
      pending = Buffer.concat([bytes(pending), bytes(chunk)]) as unknown as Buffer;
      const end = headEnd(bytes(pending));
      if (end === -1) {
        return; // the head is not complete yet
      }
      const head = pending.subarray(0, end).toString("latin1");
      const rest = pending.subarray(end);
      pending = Buffer.alloc(0);
      const { head: cleaned, origin } = stripOrigin(head);
      if (origin !== null) {
        stripped.push(origin);
      }
      const next = connect(options.upstream, () => {
        next.write(bytes(Buffer.from(cleaned, "latin1")));
        if (rest.length > 0) {
          next.write(bytes(Buffer.from(bytes(rest))));
        }
      });
      upstream = next;
      live.add(next);
      next.on("data", (back: Buffer) => client.write(bytes(back)));
      next.on("error", () => client.destroy());
      next.on("close", () => client.destroy());
    });
    client.on("close", () => {
      upstream?.destroy();
      live.delete(client);
    });
  });

  server.listen(0, "127.0.0.1", () => ready());

  return {
    get address() {
      const where = server.address();
      return typeof where === "object" && where !== null ? `127.0.0.1:${where.port}` : "";
    },
    stripped,
    ready: bound,
    stop: async () => {
      for (const socket of live) {
        socket.destroy();
      }
      live.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
