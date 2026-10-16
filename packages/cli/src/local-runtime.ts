/**
 * The local session runtime built on the RPC stack — the same `RemoteClient` ↔
 * `Connection` path used for remote daemons, but with the daemon in-process
 * (over a worker port, or an in-memory pipe in tests). This is the "TUI always
 * over RPC" lever: the agent loop + tool execution run on the daemon side, so
 * the render thread never janks, and the main thread owns persistence.
 *
 * The daemon owns the live conversation but NOT the on-disk store: after each
 * turn/compaction we read the history back via `snapshot` and write the JSON
 * record here. The main also owns the session uid (passed into `session/new`),
 * so a resumed session keeps its file.
 */
import { type JsonSessionStore, type SessionRecord, recordFromSnapshot } from "@tentacle/agent";
import { RemoteClient, type RemoteSession } from "@tentacle/client";
import type { TentacleConfig } from "@tentacle/config";
import type {
  ChatMessage,
  JobController,
  JobStatus,
  ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { type DuplexChannel, type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import type { SessionController } from "@tentacle/tui";

export interface LocalRuntime {
  readonly createSession: () => SessionController;
  /**
   * A read-only `JobController` view: only `onExit` is live (backed by the
   * daemon's background-exit stream), so the TUI surfaces job exits in the
   * worker path exactly as it does in-process. The mutating methods are never
   * called by the frontend (jobs are started/read/killed daemon-side).
   */
  readonly jobs: JobController;
  dispose(): void;
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

/**
 * Wrap a remote session so its history is persisted after each turn/compaction.
 * Reads the authoritative history back from the daemon (`snapshot`) rather than
 * reconstructing it from the update stream.
 */
export function persistingController(
  inner: RemoteSession,
  persist: (messages: readonly ChatMessage[]) => void,
): SessionController {
  const flush = async (): Promise<void> => {
    const messages = await inner.snapshot();
    if (messages && messages.length > 0) {
      persist(messages);
    }
  };
  return {
    async *send(prompt, signal) {
      try {
        yield* inner.send(prompt, signal);
      } finally {
        await flush();
      }
    },
    async compact() {
      const result = await inner.compact();
      await flush();
      return result;
    },
  };
}

export interface LocalRuntimeDeps {
  readonly channel: DuplexChannel;
  /** Called to tear down the daemon side (terminate the worker / close the pipe). */
  readonly disposeTransport: () => void;
  readonly permissions: PermissionBroker;
  readonly store: JsonSessionStore;
  readonly cwd: string;
  readonly model: string;
  /** A session to resume (its uid + history are reused), or null for a fresh one. */
  readonly resume: SessionRecord | null;
  /** Local model the daemon can tunnel calls back to (pod reverse-tunnel, F4.d). */
  readonly modelProvider?: ModelProvider;
}

/** Handshake the daemon and return a session factory that persists each turn. */
export async function createLocalRuntime(deps: LocalRuntimeDeps): Promise<LocalRuntime> {
  const client = new RemoteClient(deps.channel, deps.permissions, deps.modelProvider);
  await client.initialize();

  let seed = deps.resume;
  const createSession = (): SessionController => {
    const record = seed;
    seed = null; // only the first session resumes; /clear starts fresh
    const uid = record?.id ?? crypto.randomUUID();
    const createdAt = record?.createdAt;
    const session = client.newSession(record?.messages, uid);
    return persistingController(session, (messages) => {
      void deps.store.save(
        recordFromSnapshot(
          { id: uid, messages },
          { cwd: deps.cwd, model: deps.model, ...(createdAt !== undefined ? { createdAt } : {}) },
        ),
      );
    });
  };

  return {
    createSession,
    jobs: remoteJobsView(client),
    dispose: () => {
      client.close();
      deps.disposeTransport();
    },
  };
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
  deps: { permissions: PermissionBroker; store: JsonSessionStore; resume: SessionRecord | null },
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
  // The worker reports MCP connection errors as an object message (never a
  // string RPC frame), so a broken MCP server is surfaced without being fatal.
  worker.addEventListener("message", (event: { data: unknown }) => {
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
        store: deps.store,
        cwd: config.cwd,
        model: config.model,
        resume: deps.resume,
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
