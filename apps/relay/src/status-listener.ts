/**
 * The status listener (docs/feat/relay-status.md), shared by the relay and the
 * apps host: a SECOND server, on its own port, bound to loopback whatever the
 * service's `--host` says. The gate is `status.ts`; this file only holds the socket.
 */
import { statusResponse } from "./status.ts";

/** Never configurable: the status port is for this host only. */
const STATUS_HOST = "127.0.0.1";

export interface StatusListener {
  readonly port: number;
  stop(): void;
}

/**
 * Start it, or return `undefined` (one `status-off <code>` line) when the port
 * cannot be bound: monitoring never takes the service down.
 */
export function startStatusListener(options: {
  readonly port: number;
  readonly body: () => object;
  readonly log: (line: string) => void;
}): StatusListener | undefined {
  try {
    const server = Bun.serve({
      hostname: STATUS_HOST,
      port: options.port,
      development: false,
      fetch(req, srv) {
        return statusResponse(
          {
            method: req.method,
            pathname: new URL(req.url).pathname,
            peer: srv.requestIP(req)?.address ?? "",
            headers: req.headers,
          },
          options.body,
        );
      },
      error() {
        return new Response("internal error", { status: 500 });
      },
    });
    return { port: server.port ?? options.port, stop: () => void server.stop(true) };
  } catch (error) {
    options.log(`status-off ${(error as { code?: string }).code ?? "error"}`);
    return undefined;
  }
}
