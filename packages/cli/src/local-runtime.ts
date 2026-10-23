/**
 * The local session runtime built on the RPC stack — the same `RemoteClient` ↔
 * `Connection` path used for remote daemons, but with the daemon in-process
 * (over a worker port, or an in-memory pipe in tests). This is the "TUI always
 * over RPC" lever: the agent loop + tool execution run on the daemon side, so
 * the render thread never janks, and the main thread owns persistence.
 *
 * The daemon owns the live conversation but NOT the on-disk store: after each
 * turn/compaction we read the history back via `snapshot` and write the JSON
 * record here. The main also owns the session uid (passed into `session/open`),
 * so a resumed session keeps its file.
 *
 * Sessions outlive connections daemon-side, so this runtime closes what it
 * opened: the previous session on `/clear` (`SessionController.close`), every
 * session still open on `dispose` — the same on every runtime (AGENTS §7).
 */
import { type SessionRecord, recordFromSnapshot } from "@tentacle/agent";
import {
  type LinkStatus,
  RemoteClient,
  type RemoteSession,
  type SessionEvent,
} from "@tentacle/client";
import type { TentacleConfig } from "@tentacle/config";
import type {
  ChatMessage,
  JobController,
  JobStatus,
  ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { applyGroupMessage } from "@tentacle/exec";
import type { McpServerStatus, SkillsListResult } from "@tentacle/protocol";
import { type DuplexChannel, type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import type { SessionController } from "@tentacle/tui";
import { logDaemonError } from "./daemon-log.ts";
import { type HooksTrustStore, createHooksTrustResolver, fileTrustStore } from "./hooks-trust.ts";
import type { SessionSaver } from "./session-saver.ts";

export interface LocalRuntime {
  readonly createSession: () => SessionController;
  /**
   * A read-only `JobController` view: only `onExit` is live (backed by the
   * daemon's background-exit stream), so the TUI surfaces job exits in the
   * worker path exactly as it does in-process. The mutating methods are never
   * called by the frontend (jobs are started/read/killed daemon-side).
   */
  readonly jobs: JobController;
  /** The link's status, for the TUI's StatusBar ("reconnecting…", "disconnected: …"). */
  readonly link: { onLinkStatus(listener: (status: LinkStatus) => void): () => void };
  /** The daemon's `/name` skills as of the latest handshake (the TUI's palette). */
  readonly skills: () => readonly { readonly name: string; readonly description: string }[];
  /** The daemon's MCP servers, probed live (`mcp/status`, the TUI's `/mcp`). */
  readonly mcpStatus: () => Promise<readonly McpServerStatus[]>;
  /** Every skill the daemon discovered and its problems (`skills/list`, the TUI's `/skills`). */
  readonly skillsList: () => Promise<SkillsListResult>;
  /**
   * Wait (bounded) for the pending post-turn saves, close the open sessions
   * daemon-side, then the transport. Await it before exiting.
   */
  dispose(): Promise<void>;
}

/** A client-side `JobController` whose only live capability is `onExit`. */
function remoteJobsView(client: RemoteClient): JobController {
  return {
    start() {
      throw new Error("jobs are managed daemon-side; the client cannot start one");
    },
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose: () => {},
    onExit: (listener) =>
      client.onBackgroundExit((n) =>
        listener({
          id: n.jobId,
          command: n.command,
          status: n.status as JobStatus,
          exitCode: n.exitCode,
          startedAt: Date.now(),
        }),
      ),
  };
}

/** How long `dispose` waits for the pending post-turn saves before closing the sessions. */
export const FLUSH_ON_EXIT_TIMEOUT_MS = 3000;

/** A `SessionController` whose post-turn saves can be awaited. */
export interface PersistingController extends SessionController {
  /** `RemoteSession.enqueue`: `id` is the caller's key for the text (a `sendNow` cites it). */
  enqueue(text: string, id?: string): Promise<void>;
  /** `RemoteSession.sendNow`; the new turn is saved once it settles, like `send`'s. */
  sendNow(...args: Parameters<RemoteSession["sendNow"]>): Promise<AsyncIterable<SessionEvent>>;
  /** Resolves once no save is pending (never rejects). */
  flushed(): Promise<void>;
}

/**
 * Wrap a remote session so its history is persisted after each turn/compaction.
 * Reads the authoritative history back from the daemon (`snapshot`) rather than
 * reconstructing it from the update stream.
 *
 * The save is DETACHED from the turn (docs/feat/client-reattach-frontends.md
 * §6): with a reconnecting client the read waits out a dropped link, and the
 * turn must not look busy for the whole outage. Saves are serialized (one read
 * at a time, so disk order is history order) and coalesced (at most one more
 * waits; it reads the newest history when it runs). A failed read goes to
 * `onFlushError`, never thrown. `close` follows the pending save, so a `/clear`
 * right after a turn does not close the session under its own save.
 */
export function persistingController(
  inner: RemoteSession,
  persist: (messages: readonly ChatMessage[]) => void,
  onFlushError: (error: Error) => void = () => {},
): PersistingController {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      try {
        const messages = await inner.snapshot();
        if (messages && messages.length > 0) {
          persist(messages);
        }
      } catch (error) {
        onFlushError(error instanceof Error ? error : new Error(String(error)));
      }
    } while (again);
  };
  const flush = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = run().finally(() => {
      running = null;
    });
  };
  const flushed = (): Promise<void> => running ?? Promise.resolve();
  // A turn that failed before its first event (the link is gone for good, the
  // session closed, a send-now cancelled before it started) changed nothing:
  // reading the history back would only fail and report a save failure for a
  // complete file.
  async function* saved(events: AsyncIterable<SessionEvent>): AsyncGenerator<SessionEvent> {
    let changed = false;
    try {
      for await (const event of events) {
        changed = true;
        yield event;
      }
      changed = true;
    } finally {
      if (changed) {
        flush();
      }
    }
  }
  return {
    send(prompt, signal, opts) {
      return saved(inner.send(prompt, signal, opts));
    },
    // A refusal rejects untouched (the caller falls back); the old turn is
    // saved by its own `send`.
    async sendNow(messages, target, signal) {
      return saved(await inner.sendNow(messages, target, signal));
    },
    async compact() {
      const result = await inner.compact();
      flush();
      return result;
    },
    // Propagate the inner Promise (don't swallow it) so the TUI can reconcile
    // its optimistic entry on a delivery failure.
    enqueue(text, id) {
      return inner.enqueue(text, id);
    },
    close() {
      void flushed().then(() => inner.close());
    },
    flushed,
  };
}

export interface LocalRuntimeDeps {
  readonly channel: DuplexChannel;
  /**
   * Opens a fresh channel to the same daemon after a drop (a pod's new exec, a
   * WebSocket redial): present → the client reconnects and resumes; absent
   * (the worker) → a drop is terminal.
   */
  readonly channelFactory?: () => Promise<DuplexChannel>;
  /** Called to tear down the daemon side (terminate the worker / close the pipe). */
  readonly disposeTransport: () => void;
  readonly permissions: PermissionBroker;
  /**
   * An in-TUI notice (the session's `NoticeHub`): e.g. a reconnect that could
   * not restore the latest turn. Absent → dropped (tests, no TUI).
   */
  readonly notify?: (text: string) => void;
  /** Where each turn's history goes; its failures are reported, never thrown. */
  readonly saver: SessionSaver;
  readonly cwd: string;
  readonly model: string;
  /** A session to resume (its uid + history are reused), or null for a fresh one. */
  readonly resume: SessionRecord | null;
  /** Local model the daemon can tunnel calls back to (pod reverse-tunnel, F4.d). */
  readonly modelProvider?: ModelProvider;
  /**
   * Where the laptop stores project-hooks trust decisions — the local worker
   * ONLY (docs/feat/hooks-project-trust.md, D4). Ignored when the daemon
   * proxies the model through us (a pod, D5: asked every session, never stored).
   */
  readonly hooksTrustStore?: HooksTrustStore;
  /**
   * Non-fatal errors of the laptop-side peer (a stray/malformed daemon frame, a
   * local model failure the daemon only sees as opaque). Route to a buffered
   * sink — never a raw terminal write while Ink owns it (AGENTS §7).
   */
  readonly onPeerError?: (error: Error) => void;
}

/** Handshake the daemon and return a session factory that persists each turn. */
export async function createLocalRuntime(deps: LocalRuntimeDeps): Promise<LocalRuntime> {
  // The laptop decides `hooks/trust`, through THE single broker (AGENTS §7).
  // A pod (it tunnels the model through us) never gets the store, whatever
  // the caller passed: a pod-originated prompt never creates a lasting approval.
  const hooksTrust = createHooksTrustResolver({
    broker: deps.permissions,
    // Every RPC runtime drives the TUI, whose prompt answers the broker.
    interactive: true,
    ...(deps.hooksTrustStore && !deps.modelProvider ? { store: deps.hooksTrustStore } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
  });
  const client = new RemoteClient(deps.channel, deps.permissions, deps.modelProvider, {
    ...(deps.onPeerError ? { onError: deps.onPeerError } : {}),
    ...(deps.channelFactory ? { channelFactory: deps.channelFactory } : {}),
    hooksTrust,
  });
  await client.initialize();
  client.onHistoryLost(({ turns }) => {
    deps.notify?.(
      `⚠ The daemon lost the session while the link was down; it was restored without your last ${
        turns === 1 ? "turn" : `${turns} turns`
      } (no longer in the model's context, and not saved).`,
    );
  });

  let seed = deps.resume;
  const createSession = (): SessionController => {
    const record = seed;
    seed = null; // only the first session resumes; /clear starts fresh
    const uid = record?.id ?? crypto.randomUUID();
    const createdAt = record?.createdAt;
    const session = client.newSession(record?.messages, uid);
    const controller = persistingController(
      session,
      (messages) => {
        deps.saver.save(
          recordFromSnapshot(
            { id: uid, messages },
            { cwd: deps.cwd, model: deps.model, ...(createdAt !== undefined ? { createdAt } : {}) },
          ),
        );
      },
      (error) => deps.saver.failed(uid, `could not read the history back: ${error.message}`),
    );
    controllers.add(controller);
    return controller;
  };
  const controllers = new Set<PersistingController>();
  const allFlushed = (): Promise<void> =>
    bounded(
      Promise.all([...controllers].map((c) => c.flushed())).then(() => undefined),
      FLUSH_ON_EXIT_TIMEOUT_MS,
    );

  return {
    createSession,
    jobs: remoteJobsView(client),
    link: { onLinkStatus: (listener) => client.onLinkStatus(listener) },
    skills: () => client.skills(),
    mcpStatus: () => client.mcpStatus(),
    skillsList: () => client.skillsList(),
    dispose: async () => {
      // A quit right after a turn must not close the session under its save.
      await allFlushed();
      await client.closeSessions();
      client.close();
      deps.disposeTransport();
    },
  };
}

/** Resolve when `promise` settles or after `ms`, whichever is first; never rejects. */
function bounded(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Spawn the worker daemon and build a persisting runtime against it. Returns
 * null (after logging) on any failure — the caller falls back to in-process, so
 * a worker problem never breaks the TUI.
 */
export async function startWorkerRuntime(
  config: TentacleConfig,
  deps: { permissions: PermissionBroker; saver: SessionSaver; resume: SessionRecord | null },
  log: (line: string) => void,
): Promise<LocalRuntime | null> {
  let worker: Worker;
  // A spawn failure (e.g. a worker missing from a compiled binary) would
  // otherwise surface only as the 8s handshake timeout; capture it so the
  // fallback message says what actually happened.
  let workerError: string | null = null;
  try {
    // `new Worker` specifier resolution differs by form AND environment:
    //  - this URL form resolves relative to THIS module from source, and — on
    //    Bun >= 1.4 — against the entrypoints embedded in a compiled binary
    //    (scripts/build.ts lists worker.ts as a second entrypoint).
    //  - on Bun 1.3 the URL form fails in a compiled binary ("ModuleNotFound
    //    resolving /$bunfs/root/worker.ts"); a plain relative string works
    //    there but resolves against the CWD from source (breaking `bun test`).
    // The URL form + Bun >= 1.4 is the only combo that works in both — see the
    // TODO entry "Compiled binary drops the worker daemon".
    worker = new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module" });
    worker.addEventListener("error", (event) => {
      workerError = String((event as ErrorEvent).message);
    });
    worker.postMessage(config); // object bootstrap (structured-cloned)
  } catch (error) {
    log(`[worker] could not start (${String(error)}); using in-process\n`);
    return null;
  }
  // Object messages (never string RPC frames) from the worker: forwarded job
  // process groups (the main thread owns the exit net that kills them), and MCP
  // connection errors, surfaced without being fatal.
  worker.addEventListener("message", (event: { data: unknown }) => {
    if (applyGroupMessage(event.data)) {
      return;
    }
    const data = event.data as { type?: string; errors?: Record<string, string> } | null;
    if (data && typeof data === "object" && data.type === "mcp-errors" && data.errors) {
      for (const [name, message] of Object.entries(data.errors)) {
        log(`[mcp] server "${name}" failed to connect: ${message}\n`);
      }
    }
  });
  const channel = messagePortChannel(worker as unknown as MessageEndpoint);
  try {
    return await withTimeout(
      createLocalRuntime({
        channel,
        disposeTransport: () => worker.terminate(),
        permissions: deps.permissions,
        saver: deps.saver,
        cwd: config.cwd,
        model: config.model,
        resume: deps.resume,
        // The local worker is the one runtime whose trust decisions persist (D4).
        hooksTrustStore: fileTrustStore(config.configDir, (message) => {
          logDaemonError(config.configDir, new Error(message));
        }),
        // Laptop-side peer errors (a malformed daemon frame with no turn to
        // fail) go to the same file log as the worker's own errors — never a
        // raw terminal write while Ink owns it (AGENTS §7).
        onPeerError: (error) => {
          logDaemonError(config.configDir, error);
        },
      }),
      8000,
      "worker handshake",
    );
  } catch (error) {
    log(`[worker] handshake failed (${workerError ?? String(error)}); using in-process\n`);
    worker.terminate();
    return null;
  }
}
