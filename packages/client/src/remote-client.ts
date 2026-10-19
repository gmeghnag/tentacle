/**
 * The client runtime: an `RpcPeer` over the control channel that performs the
 * handshake, opens sessions, forwards the agent's permission requests to the
 * local `PermissionBroker` (the TUI's prompt), and routes streamed
 * `session/update`s to the right `RemoteSession`.
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
  type InitializeResult,
  JsonRpcErrorCode,
  Method,
  type ModelStreamChunkedParams,
  type ModelStreamChunkedResult,
  type ModelStreamParams,
  type ModelStreamResult,
  type NewSessionResult,
  Notification,
  PROTOCOL_VERSION,
  type PromptResult,
  type RequestId,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUpdateParams,
  type SnapshotResult,
  type StopReason,
  type WireStreamEvent,
  text,
} from "@tentacle/protocol";
import { type DuplexChannel, type RequestContext, RpcError, RpcPeer } from "@tentacle/transport";
import { responseToOutcome } from "./permission-map.ts";
import { RemoteSession } from "./remote-session.ts";

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
  private readonly handlers = new Map<string, (update: SessionUpdate) => void>();
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
          // A background exit is not turn-scoped: route it to the dedicated
          // listeners (which fire even when no turn is streaming), never to the
          // per-turn update handler.
          if (p.update.type === "background_exit") {
            const { jobId, command, status, exitCode } = p.update;
            for (const listener of this.exitListeners) {
              listener({ jobId, command, status, exitCode });
            }
            return;
          }
          this.handlers.get(p.sessionId)?.(p.update);
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

  /** Create the remote session and return its id (used lazily by `RemoteSession`). */
  async openSession(
    cwd?: string,
    messages?: readonly ChatMessage[],
    sessionId?: string,
  ): Promise<string> {
    const result = (await this.peer.request(Method.NewSession, {
      ...(cwd ? { cwd } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
      ...(sessionId ? { sessionId } : {}),
    })) as NewSessionResult;
    return result.sessionId;
  }

  /** Read the session's current history back (for the main thread to persist). */
  async snapshot(sessionId: string): Promise<readonly ChatMessage[]> {
    const result = (await this.peer.request(Method.Snapshot, { sessionId })) as SnapshotResult;
    return result.messages as readonly ChatMessage[];
  }

  prompt(sessionId: string, prompt: string): Promise<StopReason> {
    return this.peer
      .request(Method.Prompt, { sessionId, content: [text(prompt)] })
      .then((result) => (result as PromptResult).stopReason);
  }

  compact(sessionId: string): Promise<{ before: number; after: number }> {
    return this.peer
      .request(Method.Compact, { sessionId })
      .then((result) => result as CompactResult);
  }

  /** Queue a user message for the running turn (steering, mid-turn only). */
  enqueue(sessionId: string, text: string): Promise<void> {
    return this.peer.request(Method.Enqueue, { sessionId, text }).then(() => undefined);
  }

  cancel(sessionId: string): void {
    this.peer.notify(Notification.Cancel, { sessionId });
  }

  setUpdateHandler(sessionId: string, handler: ((update: SessionUpdate) => void) | null): void {
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
