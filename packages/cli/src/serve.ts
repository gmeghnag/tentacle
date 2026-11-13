/**
 * `tentacle serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import { join } from "node:path";
import { EMPTY_SKILL_LISTING, projectKey } from "@tentacle/agent";
import type { TentacleConfig } from "@tentacle/config";
import type { AttachmentSource } from "@tentacle/core";
import {
  type AgentReuse,
  Connection,
  DEFAULT_MAX_DETACHED_SESSIONS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  LogSessionStore,
  type ModelLink,
  ProxyModelProvider,
  type ReapPolicy,
  type Reapable,
  SessionHost,
  SessionPersister,
  type SessionTtlControl,
  TombstoneFile,
  acquireStoreLock,
  startReaper,
  startWsServer,
  sweepIntervalFor,
} from "@tentacle/daemon";
import type { ModelPurpose, SessionSettings, SessionSettingsReport } from "@tentacle/protocol";
import { type NodeReadableLike, type NodeWritableLike, streamChannel } from "@tentacle/transport";
import { applyCarried } from "./carried-settings.ts";
import type { ServeLimits } from "./flags.ts";
import { daemonImagePolicy } from "./image-policy.ts";
import type { ProviderFactory } from "./model-provider.ts";
import { APP_VERSION } from "./version.ts";
import {
  type SkillScan,
  type WiredAgent,
  buildAgent,
  createSkillScan,
  sweepToolOutput,
  toolOutputStore,
} from "./wiring.ts";

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
  /**
   * How this daemon's agents build their providers (docs/feat/attachments-prompt.md
   * T10): a test injects a recorder so a turn's `ChatRequest` can be inspected
   * without leaving the machine. Default `createModelProvider`.
   */
  readonly createProvider?: ProviderFactory;
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
 * The `serve` daemon's per-session agent, exported so a test can drive a whole
 * turn through it with an injected `createProvider`
 * (docs/feat/attachments-prompt.md T10) — the failure it pins is SILENT: a
 * factory that forgets `ctx.attachments` turns every image into
 * `[image unavailable]` with no error anywhere. Extracted from `createAgent`'s
 * body; no behaviour change.
 */
export function createServeAgent(
  config: TentacleConfig,
  options: Pick<ServeOptions, "onError" | "onNotice" | "createProvider">,
  skillScan: SkillScan,
  ctx: { readonly cwd: string; readonly attachments?: AttachmentSource },
): WiredAgent {
  return buildAgent(
    { ...config, cwd: ctx.cwd },
    // Hook failures: the daemon's error sink, like a turn error.
    {
      ...(options.onError ? { log: (line) => options.onError?.(new Error(line)) } : {}),
      // Not failures: the startup-facts sink, not the error one.
      ...(options.onNotice ? { notice: options.onNotice } : {}),
      ...(options.createProvider ? { createProvider: options.createProvider } : {}),
      skillScan,
      // The session's store, so the provider can read a ref's bytes
      // (docs/feat/attachments-prompt.md D4). Absent when images are off.
      ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
    },
  );
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
    // The laptop's log format (docs/feat/session-log-serve-store.md): `<uid>.jsonl`
    // + the daemon's state file. `keepSuperseded` from THIS host's config.
    const store = new LogSessionStore(dir, {
      keepSuperseded: config.sessions?.keepSuperseded === true,
      onAside: (info) => options.onNotice?.(`set ${info.file} aside: ${info.reason}`),
    });
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
  store: LogSessionStore,
  persister: SessionPersister,
  sessionTtl: SessionTtlControl,
  sameProject: (cwd: string) => boolean,
  tombstones: TombstoneFile,
): Promise<SessionHost> {
  // One skill scan for every session and for a session not created yet
  // (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  // The lock is held: this is THE daemon of the store. Silent, not awaited.
  sweepToolOutput(config);
  const images = daemonImagePolicy(config);
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    // A deleted session takes its spilled tool output with it.
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    maxDetachedSessions: options.maxDetachedSessions ?? DEFAULT_MAX_DETACHED_SESSIONS,
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    // Each session gets its own agent, confined to the daemon's cwd.
    createAgent: (cwd, ctx) => createServeAgent(config, options, skillScan, { ...ctx, cwd }),
    newSessionSkills: () => skillScan.newSession(),
    // A remote client gets an opaque turn error; the real one is logged here.
    ...(options.onError ? { onTurnError: options.onError } : {}),
    // ITS host is the user's own machine (AGENTS §7 — the only daemon that
    // persists for that reason), so a client attached to it may see the real
    // text of a failed turn — sanitized and bounded, never a raw upstream body
    // (`sanitizeTurnError`). A pod daemon (`podSessionHost`) does NOT set this.
    exposeTurnErrors: true,
    persister,
    sessionTtl,
    identity: { tentacle: APP_VERSION, kind: "serve" },
    modelInfo: { name: config.model, contextWindow: config.contextWindow },
    // ITS OWN model, told to a client for DISPLAY only (a `connect` TUI's ctx
    // meter and input rule, docs/fix/connect-model-error-drops-connection.md
    // round 2): this daemon runs its own config's model, so the laptop's window
    // is the wrong one to draw. A name and a number — never an id, URL or key.
    // The pod (`podSessionHost`) and the worker pass nothing: their model is the
    // LAPTOP's over the reverse tunnel, so the laptop's figures are already right.

    // This host's own `autoWake` (never a carried setting): a session nobody
    // is attached to wakes on a job exit (docs/feat/serve-autowake.md). The
    // stdio (pod) daemon and the worker never set it.
    wakeOnJobExit: config.autoWake,
    // This daemon runs its own config's model, so it holds the bytes
    // (docs/feat/attachments-prompt.md D4); `undefined` = no image input at all.
    ...(images ? { images } : {}),
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
  // One session at a time: an archived one is indexed from its header and
  // state file only (its log is not read), so the peak is one history plus
  // the live sessions, however many are kept. A legacy `<uid>.json` is not
  // listed (owner: no conversion).
  const { logs, orphanStates } = await store.daemonFiles();
  for (const id of orphanStates) {
    // A state file with no log: a removal cut short between the two (FM 25).
    await store.removeState(id).catch((error) => options.onError?.(error as Error));
  }
  // An image blob dir with no log (docs/feat/attachments-durable.md D3): a
  // delete cut short after its log (tombstoned), an older build's delete, or a
  // session that uploaded but never wrote a log. Nothing is live before the
  // host serves, and no history can name those bytes: removed.
  for (const id of await store.blobOrphans()) {
    await store.removeBlobs(id).catch((error) => options.onError?.(error as Error));
  }
  for (const id of logs) {
    if (sessionHost.isDeleted(id)) {
      // Finish the removal the user asked for (its tombstone is already on disk).
      persister.remove(id, false);
      continue;
    }
    const files = `${store.file(id)} / ${store.stateFile(id)}`;
    const state = await persister.loadState(id);
    if (!state.ok && state.missingState) {
      // A new session cut before its first write landed (FM 5): as today it
      // does not exist after the restart; its bytes are kept, the id is free.
      await store
        .setAside(id, "a log with no state file (a session cut before its first save landed)")
        .catch((error) => options.onError?.(error as Error));
      continue;
    }
    if (!state.ok) {
      persister.block(id);
      notice(`skipped ${files}: ${state.reason} (left as is)`);
      continue;
    }
    if (state.meta.archivedAt !== undefined) {
      sessionHost.addArchived(state.meta);
      archived++;
      continue;
    }
    const loaded = await persister.load(id);
    if (!loaded.ok) {
      persister.block(id);
      notice(`skipped ${files}: ${loaded.reason} (left as is)`);
      continue;
    }
    if (!loaded.record.paired) {
      notice(
        `session ${id}: its state file names a log entry its log no longer holds (a crash during a rewrite) — loaded the log's last segment; a cut turn is closed, not resumed`,
      );
    }
    // Running right after a restore = a turn suspended on a permission, asked again.
    if (sessionHost.restore(loaded.record).running) {
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
 * A pod daemon's agent (`serve --stdio --model-proxy`): every model call
 * travels back to the laptop over `link` — the chunked (streaming) path, and
 * the batch path the provider falls back to on a `MethodNotFound` from an old
 * laptop. `settings` (`session/open.settings`, docs/feat/config-carry.md) lay
 * the laptop's values over the pod's config, per session (`applyCarried`). With
 * `autoTitle` on, the title call rides a second tunnel that marks it `purpose:
 * "title"`, so the laptop serves it with ITS `model.titleModel`
 * (docs/feat/session-titles.md). A sub-agent on a published model rides a tunnel
 * that carries the name (docs/feat/models-map-pod.md).
 */
export function tunnelledAgent(
  podConfig: TentacleConfig,
  link: () => ModelLink | null,
  options: {
    readonly settings?: SessionSettings;
    readonly log?: (line: string) => void;
    /** The pod daemon's shared skill scan (docs/feat/skills-hot-reload.md). */
    readonly skillScan?: SkillScan;
    /** A live session's broker, jobs and approvals: a settings sync rebuilds its agent on them. */
    readonly reuse?: AgentReuse;
  } = {},
): WiredAgent & {
  readonly settingsReport?: SessionSettingsReport;
  readonly pinnedOver: readonly string[];
} {
  const { config, report, pinnedOver } = applyCarried(podConfig, options.settings);
  const ready = (): ModelLink => {
    const connection = link();
    if (!connection) {
      throw new Error("model proxy transport not ready");
    }
    return connection;
  };
  const tunnelFor = (purpose?: ModelPurpose, name?: string): ProxyModelProvider =>
    new ProxyModelProvider(
      (request) => ready().requestModelStream(request, purpose, name),
      (request, handlers) => ready().requestModelStreamChunked(request, handlers, purpose, name),
      // The exact context count at open is the LAPTOP's (the model and its key
      // stay there); an older link without it → the estimate. A named tunnel
      // never counts: only a session's own agent does, on the main model.
      name !== undefined
        ? undefined
        : (request, signal) => {
            const connection = ready();
            if (!connection.requestModelCountTokens) {
              return Promise.resolve({});
            }
            return connection.requestModelCountTokens(request, signal);
          },
    );
  // One tunnel per published name; the laptop decides whether to serve it.
  const namedTunnels = new Map<string, ProxyModelProvider>();
  const namedTunnel = (name: string): ProxyModelProvider => {
    const existing = namedTunnels.get(name);
    if (existing) {
      return existing;
    }
    const made = tunnelFor(undefined, name);
    namedTunnels.set(name, made);
    return made;
  };
  const wired = buildAgent(config, {
    ...(options.log ? { log: options.log, notice: options.log } : {}),
    // With skills off, no scan: `rescanSkills` then reads nothing (`rediscoverSkills`).
    ...(options.skillScan && config.skillsEnabled ? { skillScan: options.skillScan } : {}),
    modelOverride: tunnelFor(),
    namedModelOverride: namedTunnel,
    ...(config.autoTitle ? { titleModelOverride: tunnelFor("title") } : {}),
    ...(options.reuse
      ? {
          permissions: options.reuse.permissions,
          ...(options.reuse.jobs ? { jobs: options.reuse.jobs } : {}),
          ...(options.reuse.agentJobs ? { agentJobs: options.reuse.agentJobs } : {}),
          ...(options.reuse.grants ? { grants: options.reuse.grants } : {}),
        }
      : {}),
  });
  return { ...wired, ...(report ? { settingsReport: report } : {}), pinnedOver };
}

/** A pod daemon's flag, set by the laptop that launched it (`podDaemonCommand`). */
export interface PodDaemonOptions {
  readonly modelProxy?: boolean;
  /**
   * How this pod's agents build a provider when it runs its OWN model
   * (docs/feat/attachments-prompt.md T10): a test injects a recorder so a
   * turn's `ChatRequest` can be inspected without leaving the machine. Ignored
   * under `--model-proxy` (the laptop's provider is the one that matters).
   */
  readonly createProvider?: ProviderFactory;
}

/**
 * The `SessionHost` of a pod daemon (`serve --stdio` and `serve --resident`).
 * With `--model-proxy`, each session's model calls are tunnelled back to the
 * laptop through ITS model link — the most recently attached model-serving
 * connection, looked up per call (`AgentContext.modelLink`), so a session
 * survives one laptop connection leaving while another is attached.
 */
export function podSessionHost(
  config: TentacleConfig,
  log?: (line: string) => void,
  options: PodDaemonOptions = {},
): SessionHost {
  // The pod's own skills (Q4): its config, its filesystem — one scan for every
  // session and for a session not created yet (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  // Per line, per daemon: a `session/context` probe builds an agent too.
  const pinsLogged = new Set<string>();
  const logPins = (pinnedOver: readonly string[]): void => {
    const line = `the laptop's settings replace this pod's own: ${pinnedOver.join(", ")}`;
    if (pinnedOver.length > 0 && !pinsLogged.has(line)) {
      pinsLogged.add(line);
      log?.(line);
    }
  };
  sweepToolOutput(config);
  // `--model-proxy`: the LAPTOP is the model link, so the pod declares `client`
  // and holds no bytes (upload Owner Q2). Without it the pod runs its own
  // model, so it is a normal `store` daemon (docs/feat/attachments-prompt.md
  // D4, Orchestrator decision 8).
  const images = daemonImagePolicy(config, {
    modelProxy: options.modelProxy === true,
  });
  return new SessionHost({
    defaultCwd: config.cwd,
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    ...(images ? { images } : {}),
    // `run`/`attach`'s daemon: a skew is fixed by attaching again (it replaces it).
    identity: { tentacle: APP_VERSION, kind: "container" },
    // Only the model-proxy branch honours `settings`: a daemon the laptop does
    // not launch decides by its own config.
    newSessionSkills: async (settings) =>
      options.modelProxy && settings && !applyCarried(config, settings).config.skillsEnabled
        ? EMPTY_SKILL_LISTING
        : skillScan.newSession(),
    // The laptop gets an opaque turn error (the pod is not trusted with more
    // than it needs, and stays symmetric with `serve`); the real one goes to
    // the daemon's stderr log (piped + routed by the laptop, never inherited).
    ...(log ? { onTurnError: (error: Error) => log(`error: ${error.message}`) } : {}),
    createAgent: (cwd, { modelLink, settings, reuse, attachments }) => {
      if (!options.modelProxy) {
        // It reports nothing: a settings sync answers `applied: false`.
        return buildAgent(
          { ...config, cwd },
          {
            ...(log ? { log, notice: log } : {}),
            skillScan,
            ...(options.createProvider ? { createProvider: options.createProvider } : {}),
            // A pod daemon without `--model-proxy` runs its OWN model, so it
            // holds the bytes (D4, Orchestrator decision 8).
            ...(attachments ? { attachments } : {}),
          },
        );
      }
      const wired = tunnelledAgent({ ...config, cwd }, modelLink, {
        ...(settings ? { settings } : {}),
        ...(log ? { log } : {}),
        skillScan,
        ...(reuse ? { reuse } : {}),
      });
      logPins(wired.pinnedOver);
      return wired;
    },
  });
}

/**
 * Host the daemon over **stdio** — one `Connection` bound to a newline-delimited
 * `streamChannel` over `process.stdin`/`process.stdout`. The pod daemon of a
 * laptop older than the resident one (`serve --resident`/`--bridge`), and the
 * plain `serve --stdio` transport: the laptop pipes RPC frames to stdin and
 * reads them off stdout.
 *
 * Because stdout is the RPC channel, the caller MUST route logs to stderr.
 * Resolves when stdin closes (the client/exec disconnected).
 */
export function startStdioDaemon(
  config: TentacleConfig,
  log?: (line: string) => void,
  options: PodDaemonOptions = {},
): Promise<void> {
  const sessionHost = podSessionHost(config, log, options);
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
