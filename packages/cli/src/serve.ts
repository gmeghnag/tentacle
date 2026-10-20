/**
 * `tentacle serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import type { TentacleConfig } from "@tentacle/config";
import {
  Connection,
  type ModelStreamChunkedSender,
  type ModelStreamSender,
  ProxyModelProvider,
  type RunningServer,
  SessionHost,
  startWsServer,
} from "@tentacle/daemon";
import { type NodeReadableLike, type NodeWritableLike, streamChannel } from "@tentacle/transport";
import { buildAgent } from "./wiring.ts";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
}

export function startDaemon(config: TentacleConfig, options: ServeOptions): RunningServer {
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    // Each session gets its own agent, confined to the daemon's cwd.
    createAgent: (cwd) => buildAgent({ ...config, cwd }),
    // A remote client gets an opaque turn error; the real one is logged here.
    ...(options.onError ? { onTurnError: options.onError } : {}),
  });
  return startWsServer({
    host: options.host,
    port: options.port,
    sessionHost,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}

/**
 * Host the daemon over **stdio** — one `Connection` bound to a newline-delimited
 * `streamChannel` over `process.stdin`/`process.stdout`. This is how the daemon
 * runs inside a pod, driven over the Kubernetes `exec` channel (F4): the laptop
 * pipes RPC frames to stdin and reads them off stdout.
 *
 * Because stdout is the RPC channel, the caller MUST route logs to stderr.
 * Resolves when stdin closes (the client/exec disconnected).
 */
export function startStdioDaemon(
  config: TentacleConfig,
  log?: (line: string) => void,
  options: { modelProxy?: boolean } = {},
): Promise<void> {
  // With `--model-proxy`, the agent's model calls are tunnelled back to the
  // client over this same channel (the pod reverse-tunnel): the provider is set
  // after the Connection exists, but a session (hence the agent) is only built
  // on `session/open`, which arrives later, so the binding is always ready.
  // Both transports are wired: the chunked (streaming) path, and the batch
  // path the provider falls back to on a `MethodNotFound` from an old laptop.
  let sendModel: ModelStreamSender | null = null;
  let sendModelChunked: ModelStreamChunkedSender | null = null;
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    // The laptop gets an opaque turn error (the pod is not trusted with more
    // than it needs, and stays symmetric with `serve`); the real one goes to
    // the daemon's stderr log (piped + routed by the laptop, never inherited).
    ...(log ? { onTurnError: (error: Error) => log(`error: ${error.message}`) } : {}),
    createAgent: (cwd) =>
      options.modelProxy
        ? buildAgent(
            { ...config, cwd },
            {
              modelOverride: new ProxyModelProvider(
                (request) => {
                  if (!sendModel) {
                    throw new Error("model proxy transport not ready");
                  }
                  return sendModel(request);
                },
                (request, handlers) => {
                  if (!sendModelChunked) {
                    throw new Error("model proxy transport not ready");
                  }
                  return sendModelChunked(request, handlers);
                },
              ),
            },
          )
        : buildAgent({ ...config, cwd }),
  });
  const channel = streamChannel(
    process.stdin as unknown as NodeReadableLike,
    process.stdout as unknown as NodeWritableLike,
  );
  const connection = new Connection(
    channel,
    sessionHost,
    log ? (error) => log(`error: ${error.message}`) : undefined,
    // Its turns cannot reach the model once this connection is gone: cancel
    // them cleanly on detach instead of failing mid-round (sessions stay).
    { servesModel: options.modelProxy === true },
  );
  if (options.modelProxy) {
    sendModel = (request) => connection.requestModelStream(request);
    sendModelChunked = (request, handlers) =>
      connection.requestModelStreamChunked(request, handlers);
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      connection.close();
      resolve();
    };
    // Resolve when stdin ends — independent of the channel's own close handler
    // (which the RpcPeer owns), so we never clobber the peer's wiring.
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}
