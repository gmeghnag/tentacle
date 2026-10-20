/**
 * The client runtime: an `RpcPeer` over the control channel that performs the
 * handshake, opens (and, when done with them, closes) sessions, forwards the
 * agent's permission requests to the local `PermissionBroker` (the TUI's
 * prompt), and routes streamed `session/update`s to the right `RemoteSession`.
 */
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  PermissionBroker,
  PermissionRequest,
} from "@tentacle/core";
import {
  type CompactResult,
  DomainErrorCode,
  type InitializeResult,
  JsonRpcErrorCode,
  Method,
  type ModelStreamChunkedParams,
  type ModelStreamChunkedResult,
  type ModelStreamParams,
  type ModelStreamResult,
  Notification,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptResult,
  type RequestId,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUpdateParams,
  type SnapshotResult,
  type WireStreamEvent,
  text,
} from "@tentacle/protocol";
import { type DuplexChannel, type RequestContext, RpcError, RpcPeer } from "@tentacle/transport";
import { classifyUpdate } from "./mapping.ts";
import { responseToOutcome } from "./permission-map.ts";
import { RemoteSession } from "./remote-session.ts";

/** How long the exit path waits for the daemon to acknowledge `session/close`s. */
export const CLOSE_SESSIONS_TIMEOUT_MS = 1000;
/** Page size `snapshot` reads the history with (bounded frames for long sessions). */
const SNAPSHOT_PAGE = 200;
/** Restarts of a paged `snapshot` after a compaction raced it, before giving up. */
const SNAPSHOT_ATTEMPTS = 3;
/**
 * Pages one `snapshot` may read (10 000 × 200 messages): a daemon — a pod is
 * not trusted — that never stops returning a cursor fails loudly here instead
 * of growing the laptop's memory without bound.
 */
const SNAPSHOT_MAX_PAGES = 10_000;

/** A session's in-flight turn: receives its updates, or a stream error that must fail it. */
export interface SessionStreamHandler {
  update(update: SessionUpdate): void;
  fail(error: Error): void;
}

/** A background-job exit surfaced by the daemon, outside any turn. */
export interface BackgroundExitNotice {
  readonly jobId: string;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
}

/**
 * `model/streamChunked` coalescing (a leading-edge throttle): after a quiet
 * period an event goes out AT ONCE (no added first-token latency); events that
 * arrive within the next window ride one `$/progress` frame as a batch, so a
 * fast model (or a slow link: k8s exec through the API server, a WAN
 * `connect`) pays per-frame overhead at most once per window, not per event.
 */
export const MODEL_STREAM_COALESCE_MS = 30;
/**
 * Upper bound on one batch's serialized size (UTF-16 units). A batch is closed
 * before it would exceed this, far below a receiver's `maxFrameBytes` (8 MiB on
 * the ws-server); a single event larger than it travels alone.
 */
export const MODEL_STREAM_BATCH_MAX_CHARS = 64 * 1024;

export class RemoteClient {
  private readonly peer: RpcPeer;
  private readonly permissions: PermissionBroker;
  private readonly handlers = new Map<string, SessionStreamHandler>();
  /** Sessions this client opened and has not closed: `closeSessions` ends them. */
  private readonly opened = new Set<string>();
  /** Session-independent listeners for background-job exits (idle or mid-turn). */
  private readonly exitListeners = new Set<(notice: BackgroundExitNotice) => void>();

  private readonly modelProvider?: ModelProvider;
  private readonly onError?: (error: Error) => void;

  constructor(
    channel: DuplexChannel,
    permissions: PermissionBroker,
    modelProvider?: ModelProvider,
    options: { readonly onError?: (error: Error) => void } = {},
  ) {
    this.permissions = permissions;
    if (modelProvider) {
      this.modelProvider = modelProvider;
    }
    if (options.onError) {
      this.onError = options.onError;
    }
    this.peer = new RpcPeer(channel, {
      onNotification: (method, params) => {
        if (method === Notification.SessionUpdate) {
          const p = params as SessionUpdateParams;
          const classified = classifyUpdate(p);
          // An unknown display event is skipped by contract (a newer daemon's);
          // logging it would flood onError with every such frame.
          if (classified.kind === "ignore") return;
          if (classified.kind === "error") {
            this.onError?.(classified.error);
            this.handlers.get(p.sessionId)?.fail(classified.error);
            return;
          }
          const update = classified.update;
          // Closed daemon-side (by any client): nothing left to close at exit.
          if (update.type === "session_closed") {
            this.opened.delete(p.sessionId);
          }
          // A background exit is not turn-scoped: route it to the dedicated
          // listeners (which fire even when no turn is streaming), never to the
          // per-turn update handler.
          if (update.type === "background_exit") {
            const { jobId, command, status, exitCode } = update;
            for (const listener of this.exitListeners) {
              listener({ jobId, command, status, exitCode });
            }
            return;
          }
          this.handlers.get(p.sessionId)?.update(update);
        }
      },
      onRequest: async (method, params, context) => {
        if (method === Method.RequestPermission) {
          return this.onPermission(params as RequestPermissionParams);
        }
        if (method === Method.ModelStream) {
          return this.onModelStream(params as ModelStreamParams);
        }
        if (method === Method.ModelStreamChunked) {
          return this.onModelStreamChunked(
            params as ModelStreamChunkedParams,
            context as RequestContext,
          );
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unexpected request: ${method}`);
      },
      // A `session/update` whose ENVELOPE failed the schema (no `seq`, a
      // non-object update, …) never reaches `classifyUpdate`: fail its session's
      // turn here, or a broken `turn_end` would hang it. `onError` already got
      // the error from the peer. An unreadable `sessionId` cannot be routed.
      onInvalidNotification: (method, params) => {
        if (method !== Notification.SessionUpdate) return;
        const sessionId =
          params && typeof params === "object" ? (params as { sessionId?: unknown }).sessionId : "";
        if (typeof sessionId === "string") {
          this.handlers
            .get(sessionId)
            ?.fail(new Error("malformed session/update frame from the daemon"));
        }
      },
      // The turn's outcome now arrives in the stream, not as a pending
      // response, so a dead socket must end every open turn explicitly (same
      // error a pending request gets).
      onClose: () => {
        for (const handler of [...this.handlers.values()]) {
          handler.fail(new RpcError(JsonRpcErrorCode.InternalError, "connection closed"));
        }
      },
      // Log non-fatal peer errors (a stray/malformed notification, a bad frame)
      // instead of dropping them silently. Routed to the caller's sink, NEVER a
      // raw terminal write (§7): the laptop's stdout is the RPC channel/Ink's.
      ...(this.onError ? { onError: (error: Error) => this.onError?.(error) } : {}),
    });
  }

  /** Handshake; rejects on an incompatible daemon version. */
  async initialize(): Promise<InitializeResult> {
    return (await this.peer.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    })) as InitializeResult;
  }

  /** A controller the Ink App drives exactly like a local `Session`. */
  newSession(seedMessages?: readonly ChatMessage[], sessionId?: string): RemoteSession {
    return new RemoteSession(this, seedMessages, sessionId);
  }

  /**
   * Open (create) the remote session and return its id (used lazily by
   * `RemoteSession`). `create: true`: this client starts the session — a
   * daemon that already has a live one under `sessionId` attaches instead.
   * (Re-attaching with `since`/resync is `client-reattach`'s.)
   */
  async openSession(
    cwd?: string,
    messages?: readonly ChatMessage[],
    sessionId?: string,
  ): Promise<string> {
    const result = (await this.peer.request(Method.Open, {
      create: true,
      ...(cwd ? { cwd } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
      ...(sessionId ? { sessionId } : {}),
    })) as OpenResult;
    this.opened.add(result.sessionId);
    return result.sessionId;
  }

  /**
   * End a session daemon-side (its turn, its background jobs) — sessions
   * outlive connections, so a client that is done with one says so. Resolves
   * when the daemon answered — or the request failed (peer closed: moot);
   * never rejects.
   */
  closeSession(sessionId: string): Promise<void> {
    this.opened.delete(sessionId);
    return this.peer.request(Method.Close, { sessionId }).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Close every session this client opened and has not closed yet — the exit
   * path. AWAIT it before `close()`: a frame written just before closing is not
   * guaranteed to be delivered on every transport (the in-memory pair drops
   * it). Bounded by `timeoutMs` so a hung daemon never blocks the exit; never
   * rejects.
   */
  async closeSessions(timeoutMs: number = CLOSE_SESSIONS_TIMEOUT_MS): Promise<void> {
    const pending = [...this.opened].map((sessionId) => this.closeSession(sessionId));
    if (pending.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Read the session's history back at its current cut (for the main thread to
   * persist), page by page, newest first, joined chronologically. A compaction
   * landing between two pages makes the cursor stale: start over.
   */
  async snapshot(sessionId: string): Promise<readonly ChatMessage[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readSnapshotPages(sessionId);
      } catch (error) {
        const stale = error instanceof RpcError && error.code === DomainErrorCode.StaleCursor;
        if (!stale || attempt >= SNAPSHOT_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async readSnapshotPages(sessionId: string): Promise<readonly ChatMessage[]> {
    const pages: (readonly ChatMessage[])[] = [];
    let cursor: string | undefined;
    do {
      if (pages.length >= SNAPSHOT_MAX_PAGES) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "snapshot: too many pages");
      }
      const previous = cursor;
      const result = (await this.peer.request(Method.Snapshot, {
        sessionId,
        limit: SNAPSHOT_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })) as SnapshotResult;
      cursor = result.cursor;
      // Every page that points further back must make progress.
      if (cursor !== undefined && (result.messages.length === 0 || cursor === previous)) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "snapshot: cursor made no progress");
      }
      pages.push(result.messages as readonly ChatMessage[]);
    } while (cursor !== undefined);
    return pages.reverse().flat();
  }

  /** Start a turn; resolves with the daemon's ack (the turn ends in the stream). */
  prompt(sessionId: string, turnId: string, prompt: string): Promise<PromptResult> {
    return this.peer
      .request(Method.Prompt, { sessionId, turnId, content: [text(prompt)] })
      .then((result) => result as PromptResult);
  }

  compact(sessionId: string): Promise<{ before: number; after: number }> {
    return this.peer
      .request(Method.Compact, { sessionId })
      .then((result) => result as CompactResult);
  }

  /**
   * Queue a user message for the running turn `turnId` (steering, mid-turn
   * only). `id` is the idempotency key: resending it is a no-op success.
   */
  enqueue(sessionId: string, id: string, turnId: string, text: string): Promise<void> {
    return this.peer.request(Method.Enqueue, { sessionId, id, turnId, text }).then(() => undefined);
  }

  cancel(sessionId: string): void {
    this.peer.notify(Notification.Cancel, { sessionId });
  }

  setUpdateHandler(sessionId: string, handler: SessionStreamHandler | null): void {
    if (handler) {
      this.handlers.set(sessionId, handler);
    } else {
      this.handlers.delete(sessionId);
    }
  }

  /** Subscribe to background-job exits across all sessions; returns an unsubscribe. */
  onBackgroundExit(listener: (notice: BackgroundExitNotice) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    this.peer.close();
  }

  /**
   * Serve a `model/stream` request from the daemon (the pod reverse-tunnel),
   * batch cut: run the LOCAL model and return the whole turn's events in one
   * response. Kept so an old daemon (which only knows `model/stream`) works
   * against a new laptop.
   */
  private async onModelStream(params: ModelStreamParams): Promise<ModelStreamResult> {
    if (!this.modelProvider) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "no local model to serve model/stream");
    }
    const events: WireStreamEvent[] = [];
    for await (const event of this.modelProvider.stream(params.request as unknown as ChatRequest)) {
      events.push(event as WireStreamEvent);
    }
    return { events };
  }

  /**
   * Serve a `model/streamChunked` request (the streaming cut): run the LOCAL
   * model and forward its events to the daemon as `$/progress` notifications
   * tied to the request id, coalesced into batches, then reply with only a
   * frame count. The events cross as `$/progress` (NOT re-sent in the result), so
   * the daemon can yield them as they are produced.
   *
   * Ordering is the load-bearing guarantee: every `$/progress` for this request
   * is sent **before** the result frame (the coalescer flushes synchronously on
   * end/error), and the channel is ordered, so the daemon's peer routes all
   * chunks before it resolves the result. The count check then proves
   * completeness.
   */
  private async onModelStreamChunked(
    params: ModelStreamChunkedParams,
    context: RequestContext,
  ): Promise<ModelStreamChunkedResult> {
    if (!this.modelProvider) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "no local model to serve model/streamChunked",
      );
    }
    const signal = context.signal;
    const id = String(context.id);
    // Coalesce into batches (see MODEL_STREAM_COALESCE_MS): one frame per
    // window at most, a quiet stream's next event at once, a size cap per
    // batch. `seq` counts FRAMES. The final flush is synchronous, before the
    // result/error frame, so no event is ever delayed past it.
    let batch: WireStreamEvent[] = [];
    let batchChars = 2; // "[]"
    let seq = 0;
    let window: ReturnType<typeof setTimeout> | undefined;
    const sendBatch = (): void => {
      if (batch.length === 0) {
        return;
      }
      this.peer.notify(Notification.Progress, { id, seq, value: batch });
      seq += 1;
      batch = [];
      batchChars = 2;
    };
    const onWindowEnd = (): void => {
      window = undefined;
      if (batch.length > 0) {
        sendBatch();
        window = setTimeout(onWindowEnd, MODEL_STREAM_COALESCE_MS);
      }
    };
    const push = (event: WireStreamEvent): void => {
      const size = JSON.stringify(event).length + 1; // + the separating comma
      if (batch.length > 0 && batchChars + size > MODEL_STREAM_BATCH_MAX_CHARS) {
        sendBatch(); // close the batch before it would exceed the cap
      }
      batch.push(event);
      batchChars += size;
      if (window === undefined) {
        // Leading edge: the stream was quiet, so send now and open a window.
        sendBatch();
        window = setTimeout(onWindowEnd, MODEL_STREAM_COALESCE_MS);
      } else if (batchChars >= MODEL_STREAM_BATCH_MAX_CHARS) {
        sendBatch(); // an oversize event travels alone, without waiting
      }
    };
    const flush = (): void => {
      if (window) {
        clearTimeout(window);
        window = undefined;
      }
      sendBatch();
    };
    try {
      for await (const event of this.modelProvider.stream({
        ...(params.request as unknown as ChatRequest),
        ...(signal ? { signal } : {}),
      })) {
        const wire = event as WireStreamEvent;
        push(wire);
      }
    } catch (error) {
      // Flush whatever was produced before the failure so the daemon sees the
      // partial stream, then surface the error (the daemon drains, then throws).
      flush();
      if (
        signal.aborted ||
        (error && typeof error === "object" && (error as { name?: string }).name === "cancelled")
      ) {
        throw new RpcError(JsonRpcErrorCode.InternalError, "model stream cancelled");
      }
      // Rethrow as-is (NOT an RpcError): the peer reports it to `onError` on
      // the laptop and answers the pod with an opaque "internal error", like
      // `model/stream`. A provider message can carry the endpoint or key
      // material, and the pod is not trusted (AGENTS §7).
      throw error;
    }
    // Flush the tail synchronously so the last events precede the result frame.
    flush();
    return { chunks: seq };
  }

  private async onPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const req: PermissionRequest = {
      tool: "",
      level: "ask",
      title: params.title,
      ...(params.explanation ? { detail: params.explanation } : {}),
      input: {},
    };
    const response = await this.permissions.request(req);
    return { outcome: responseToOutcome(response) };
  }
}
