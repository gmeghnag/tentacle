/**
 * `tentacle serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import { join } from "node:path";
import { JsonSessionStore, projectKey } from "@tentacle/agent";
import type { TentacleConfig } from "@tentacle/config";
import {
  Connection,
  DEFAULT_MAX_DETACHED_SESSIONS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  type ModelStreamChunkedSender,
  type ModelStreamSender,
  ProxyModelProvider,
  SessionHost,
  SessionPersister,
  acquireStoreLock,
  parseDaemonRecord,
  startReaper,
  startWsServer,
} from "@tentacle/daemon";
import { type NodeReadableLike, type NodeWritableLike, streamChannel } from "@tentacle/transport";
import type { ServeLimits } from "./flags.ts";
import { buildAgent, skillCatalog, skillListing } from "./wiring.ts";

/** Floor for the derived sweep period. */
const MIN_SWEEP_INTERVAL_MS = 1000;

/**
 * The reaper's period: never coarser than the TTL or the cap (a short
 * `--session-ttl` is honoured to within one TTL, not one minute), never finer
 * than 1 s (a `1ms` TTL must not spin the event loop).
 */
export function sweepIntervalFor(idleTtlMs: number, adminCapMs?: number): number {
  return Math.max(
    MIN_SWEEP_INTERVAL_MS,
    Math.min(DEFAULT_SWEEP_INTERVAL_MS, idleTtlMs, adminCapMs ?? idleTtlMs),
  );
}

export interface ServeOptions extends ServeLimits {
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
  /** Startup facts worth a line (sessions restored, files skipped) — printed before listening. */
  readonly onNotice?: (line: string) => void;
  /** Reaper sweep period (ms); tests shorten it. */
  readonly sweepIntervalMs?: number;
}

/** A running `serve`: `stop` waits for every session write, then releases the store. */
export interface ServeHandle {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Where a `serve` daemon keeps its sessions: one directory per project, apart
 * from the client's `<configDir>/sessions` (the client writes the same uids).
 */
export function daemonStoreDir(config: Pick<TentacleConfig, "configDir" | "cwd">): string {
  return join(config.configDir, "daemon", projectKey(config.cwd));
}

/**
 * The long-lived daemon: sessions outlive connections here, so this is where
 * they are bounded — daemon-wide limits on `SessionHost` and the idle-TTL
 * reaper, owned with the registry and stopped with the server — and where they
 * outlive the PROCESS: the only daemon that persists (its host is the user's
 * own machine; a pod daemon never does, AGENTS §7). Before listening it takes
 * the store's lock (one daemon per store) and reloads every session it left,
 * detached; a file it cannot use is reported and left untouched.
 */
export async function startDaemon(
  config: TentacleConfig,
  options: ServeOptions,
): Promise<ServeHandle> {
  const dir = daemonStoreDir(config);
  const lock = acquireStoreLock(dir);
  let persister: SessionPersister | undefined;
  try {
    const store = new JsonSessionStore(dir);
    persister = new SessionPersister({
      store,
      cwd: config.cwd,
      model: config.model,
      onError: options.onError ?? (() => {}),
    });
    const sessionHost = await reloadedHost(config, options, store, persister);
    return listen(sessionHost, options, async () => {
      await persister?.stop();
      lock.release();
    });
  } catch (error) {
    await persister?.stop();
    lock.release();
    throw error;
  }
}

/** The registry, with every usable record of `store` restored into it. */
async function reloadedHost(
  config: TentacleConfig,
  options: ServeOptions,
  store: JsonSessionStore,
  persister: SessionPersister,
): Promise<SessionHost> {
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    maxDetachedSessions: options.maxDetachedSessions ?? DEFAULT_MAX_DETACHED_SESSIONS,
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    // Each session gets its own agent, confined to the daemon's cwd.
    createAgent: (cwd) =>
      buildAgent(
        { ...config, cwd },
        // Hook failures: the daemon's error sink, like a turn error.
        options.onError ? { log: (line) => options.onError?.(new Error(line)) } : {},
      ),
    skills: skillCatalog(config),
    skillList: skillListing(config),
    // A remote client gets an opaque turn error; the real one is logged here.
    ...(options.onError ? { onTurnError: options.onError } : {}),
    persister,
  });
  const notice = options.onNotice ?? (() => {});
  const { records, skipped } = await store.list();
  for (const bad of skipped) {
    persister.block(bad.id);
    notice(`skipped ${bad.file}: ${bad.reason} (left as is)`);
  }
  let restored = 0;
  let resumed = 0;
  // By project key, not by string: the same project through a symlink (or a
  // trailing slash) shares this directory and must restore its sessions.
  const key = projectKey(config.cwd);
  for (const record of records) {
    const parsed = parseDaemonRecord(record, (cwd) => projectKey(cwd) === key);
    if (!parsed.ok) {
      persister.block(record.id);
      notice(
        `skipped ${join(daemonStoreDir(config), `${record.id}.json`)}: ${parsed.reason} (left as is)`,
      );
      continue;
    }
    // Running right after a restore = a turn suspended on a permission, asked again.
    if (sessionHost.restore(parsed.record).running) {
      resumed++;
    }
    restored++;
  }
  if (restored > 0) {
    const waiting =
      resumed > 0
        ? ` (${resumed} resumed a turn waiting for approval — answer it from any client)`
        : "";
    notice(
      `restored ${restored} session${restored === 1 ? "" : "s"} from ${daemonStoreDir(config)}${waiting}`,
    );
  }
  return sessionHost;
}

/** Serve `sessionHost` over the WebSocket, with its reaper; `release` runs after both stop. */
function listen(
  sessionHost: SessionHost,
  options: ServeOptions,
  release: () => Promise<void>,
): ServeHandle {
  const server = startWsServer({
    host: options.host,
    port: options.port,
    sessionHost,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
    ...(options.wsIdleTimeoutSec !== undefined ? { idleTimeoutSec: options.wsIdleTimeoutSec } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const idleTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const stopReaper = startReaper(
    sessionHost,
    {
      idleTtlMs,
      ...(options.adminCapMs !== undefined ? { adminCapMs: options.adminCapMs } : {}),
    },
    {
      sweepIntervalMs: options.sweepIntervalMs ?? sweepIntervalFor(idleTtlMs, options.adminCapMs),
      ...(options.onAudit ? { onAudit: options.onAudit } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    },
  );
  let stopping: Promise<void> | undefined;
  return {
    url: server.url,
    port: server.port,
    stop: () => {
      stopping ??= (async () => {
        stopReaper();
        server.stop();
        await release();
      })();
      return stopping;
    },
  };
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
    // The pod's own skills (Q4): its config, its filesystem.
    skills: skillCatalog(config),
    skillList: skillListing(config),
    // The laptop gets an opaque turn error (the pod is not trusted with more
    // than it needs, and stays symmetric with `serve`); the real one goes to
    // the daemon's stderr log (piped + routed by the laptop, never inherited).
    ...(log ? { onTurnError: (error: Error) => log(`error: ${error.message}`) } : {}),
    createAgent: (cwd) =>
      options.modelProxy
        ? buildAgent(
            { ...config, cwd },
            {
              ...(log ? { log } : {}),
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
        : buildAgent({ ...config, cwd }, log ? { log } : {}),
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
