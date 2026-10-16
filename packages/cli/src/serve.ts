/**
 * `tentacle serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import type { TentacleConfig } from "@tentacle/config";
import {
  Connection,
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
  // on `session/new`, which arrives later, so the binding is always ready.
  let sendModel: ModelStreamSender | null = null;
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    createAgent: (cwd) =>
      options.modelProxy
        ? buildAgent(
            { ...config, cwd },
            {
              modelOverride: new ProxyModelProvider((request) => {
                if (!sendModel) {
                  throw new Error("model proxy transport not ready");
                }
                return sendModel(request);
              }),
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
  );
  if (options.modelProxy) {
    sendModel = (request) => connection.requestModelStream(request);
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
