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
  type ModelStreamChunkedSender,
  type ModelStreamSender,
  ProxyModelProvider,
  type ReapPolicy,
  type Reapable,
  SessionHost,
  SessionPersister,
  type SessionTtlControl,
  TombstoneFile,
  acquireStoreLock,
  parseDaemonRecord,
  startReaper,
  startWsServer,
  sweepIntervalFor,
} from "@tentacle/daemon";
import { type NodeReadableLike, type NodeWritableLike, streamChannel } from "@tentacle/transport";
import type { ServeLimits } from "./flags.ts";
import { APP_VERSION } from "./version.ts";
import { buildAgent, skillCatalog, skillListing } from "./wiring.ts";

/**
 * The host takes its `SessionTtlControl` at construction, before `listen`
 * exists to own the reaper: this forwards to the one `listen` binds. Used
 * unbound it is a programming error (it throws), never a silent no-op.
 */
class BoundSessionTtl implements SessionTtlControl {
  private impl: SessionTtlControl | undefined;

  bind(impl: SessionTtlControl): void {
    this.impl = impl;
  }

  get(): number | null {
    return this.bound().get();
  }

  set(idleTtlMs: number | null): void {
    this.bound().set(idleTtlMs);
  }

  private bound(): SessionTtlControl {
    if (!this.impl) {
      throw new Error("session TTL control used before the reaper was bound");
    }
    return this.impl;
  }
}

/** A TTL for the audit line: `never`, or milliseconds. */
function describeTtl(idleTtlMs: number | null): string {
  return idleTtlMs === null ? "never" : `${idleTtlMs}ms`;
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
 * the store's lock (one daemon per store) and reloads every live session it
 * left, detached, and indexes every archived one (reopened on demand); a file
 * it cannot use is reported and left untouched.
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
    // By project key, not by string: the same project through a symlink (or a
    // trailing slash) shares this directory and must restore its sessions.
    const key = projectKey(config.cwd);
    const sameProject = (cwd: string): boolean => projectKey(cwd) === key;
    // Deleted ids, for good: in the store directory beside the records (F1).
    const tombstones = new TombstoneFile(dir);
    persister = new SessionPersister({
      store,
      cwd: config.cwd,
      model: config.model,
      onError: options.onError ?? (() => {}),
      sameProject,
      tombstones,
    });
    const ttl = new BoundSessionTtl();
    const sessionHost = await reloadedHost(
      config,
      options,
      store,
      persister,
      ttl,
      sameProject,
      tombstones,
    );
    return listen(sessionHost, options, ttl, async () => {
      await persister?.stop();
      lock.release();
    });
  } catch (error) {
    await persister?.stop();
    lock.release();
    throw error;
  }
}

/** The registry: every usable live record of `store` restored, every archived one indexed. */
async function reloadedHost(
  config: TentacleConfig,
  options: ServeOptions,
  store: JsonSessionStore,
  persister: SessionPersister,
  sessionTtl: SessionTtlControl,
  sameProject: (cwd: string) => boolean,
  tombstones: TombstoneFile,
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
    sessionTtl,
    identity: { tentacle: APP_VERSION, kind: "serve" },
  });
  const notice = options.onNotice ?? (() => {});
  let restored = 0;
  let resumed = 0;
  let archived = 0;
  // Tombstones first: a record still beside its tombstone (a delete cut short
  // between the two writes) is never restored.
  // An unreadable file refuses the start (fail-closed: else offline clients
  // could revive deleted sessions); a garbled line is skipped with a notice.
  let ids: string[];
  try {
    ids = await tombstones.load((line) =>
      notice(
        `skipped an unreadable line in ${tombstones.path}: ${JSON.stringify(line)} — that session, if deleted, may be recreated by a client`,
      ),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `can't start: couldn't read ${tombstones.path}: ${reason} (fix its permissions or contents; it records the sessions deleted earlier, and removing it lets a client recreate them)`,
      { cause: error },
    );
  }
  for (const id of ids) {
    sessionHost.addDeleted(id);
  }
  // One record at a time (`scan`): an archived one keeps only its metadata,
  // so the peak is one record plus the live sessions, however many are kept.
  for await (const { id, result } of store.scan()) {
    if (result.status === "absent") {
      continue;
    }
    if (sessionHost.isDeleted(id)) {
      // Finish the removal the user asked for (its tombstone is already on disk).
      persister.remove(id, false);
      continue;
    }
    if (result.status === "unreadable") {
      persister.block(id);
      notice(`skipped ${result.file}: ${result.reason} (left as is)`);
      continue;
    }
    const parsed = parseDaemonRecord(result.record, sameProject);
    if (!parsed.ok) {
      persister.block(id);
      notice(
        `skipped ${join(daemonStoreDir(config), `${id}.json`)}: ${parsed.reason} (left as is)`,
      );
      continue;
    }
    if (parsed.record.archivedAt !== undefined) {
      sessionHost.addArchived(parsed.record);
      archived++;
      continue;
    }
    // Running right after a restore = a turn suspended on a permission, asked again.
    if (sessionHost.restore(parsed.record).running) {
      resumed++;
    }
    restored++;
  }
  if (restored > 0 || archived > 0) {
    const waiting =
      resumed > 0
        ? ` (${resumed} resumed a turn waiting for approval — answer it from any client)`
        : "";
    const kept = archived > 0 ? `, ${archived} archived,` : "";
    notice(
      `restored ${restored} session${restored === 1 ? "" : "s"}${kept} from ${daemonStoreDir(config)}${waiting}`,
    );
  }
  return sessionHost;
}

/** Serve `sessionHost` over the WebSocket, with its reaper; `release` runs after both stop. */
function listen(
  sessionHost: SessionHost,
  options: ServeOptions,
  ttl: BoundSessionTtl,
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
  // The reaper's policy has ONE owner: this function. A runtime change
  // (`daemon/session_ttl`) swaps `policy` and re-arms the interval — nothing
  // else caches the TTL. `null` = never (`--session-ttl never`).
  let policy: ReapPolicy = {
    idleTtlMs: options.sessionTtlMs === undefined ? DEFAULT_SESSION_TTL_MS : options.sessionTtlMs,
    ...(options.adminCapMs !== undefined ? { adminCapMs: options.adminCapMs } : {}),
  };
  let stopReaper: (() => void) | undefined;
  let stopped = false;
  // The running reaper's period (null = none) and the ABSOLUTE time of its next
  // sweep: set when it is armed (its first sweep may be sooner than a period)
  // and moved on at each sweep.
  let armedMs: number | null = null;
  let nextSweepAt = 0;
  const sweeping: Reapable = {
    reapExpired: (p, onError) => {
      nextSweepAt = Date.now() + (armedMs ?? 0);
      return sessionHost.reapExpired(p, onError);
    },
  };
  /**
   * Make the running reaper fit `policy`. The sweep reads the CURRENT policy
   * itself, so a change that keeps the period needs no restart; restarting on
   * every set would push the next sweep later each time and a client setting
   * more often than the period would starve the TTL and the admin cap. Only
   * a period change (or none ↔ some) restarts, and the new reaper's first
   * sweep is `min(next due, now + new period)`: never later than the earliest
   * due time, however many changes land before it runs.
   */
  const arm = (): void => {
    // Nothing to sweep for (never, no cap) → no timer at all.
    const wanted = stopped
      ? null
      : (options.sweepIntervalMs ?? sweepIntervalFor(policy.idleTtlMs, policy.adminCapMs));
    if (wanted === armedMs) {
      return;
    }
    stopReaper?.();
    stopReaper = undefined;
    const now = Date.now();
    const pending = armedMs !== null;
    armedMs = wanted;
    if (wanted === null) {
      return;
    }
    // From no timer: a full period. Else the sooner of what was already due and a new period.
    const firstSweepInMs = pending ? Math.min(wanted, Math.max(0, nextSweepAt - now)) : wanted;
    nextSweepAt = now + firstSweepInMs;
    stopReaper = startReaper(sweeping, () => policy, {
      sweepIntervalMs: wanted,
      ...(pending ? { firstSweepInMs } : {}),
      ...(options.onAudit ? { onAudit: options.onAudit } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  };
  arm();
  ttl.bind({
    get: () => policy.idleTtlMs,
    set: (idleTtlMs) => {
      options.onAudit?.(
        `session-ttl ${describeTtl(policy.idleTtlMs)} -> ${describeTtl(idleTtlMs)}`,
      );
      policy = { ...policy, idleTtlMs };
      arm();
    },
  });
  let stopping: Promise<void> | undefined;
  return {
    url: server.url,
    port: server.port,
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        stopReaper?.();
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
    // `run`/`attach`'s daemon: a skew is fixed by attaching again (it replaces it).
    identity: { tentacle: APP_VERSION, kind: "container" },
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
