/**
 * One client connection: an `RpcPeer` bound to a `SessionHost`. Handles the
 * handshake and the `session/*` methods, holds this client's ATTACHMENTS to the
 * host's sessions (each streams `session/update` notifications here and can
 * receive permission requests), and detaches them — never ends a session — when
 * the connection goes away.
 *
 * Methods other than `initialize` are refused until the handshake completes, and
 * an incompatible protocol major is rejected — security/versioning live here.
 */
import {
  type CancelParams,
  type CloseParams,
  type CloseResult,
  type CompactParams,
  type CompactResult,
  type EnqueueParams,
  type EnqueueResult,
  type InitializeParams,
  type InitializeResult,
  Method,
  type ModelStreamChunkedResult,
  type ModelStreamResult,
  Notification,
  type OpenParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptParams,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SnapshotParams,
  type SnapshotResult,
  type WireChatRequest,
} from "@tentacle/protocol";
import {
  DomainErrorCode,
  type DuplexChannel,
  type RequestContext,
  RpcError,
  RpcPeer,
} from "@tentacle/transport";
import type { Attachment, HostedSession } from "./hosted-session.ts";
import type { SessionHost } from "./session-host.ts";

/** Per-connection resource limits (the daemon's exposure boundary sets these). */
export interface ConnectionOptions {
  /** Auto-deny a `session/request_permission` the client leaves unanswered this long. */
  readonly permissionTimeoutMs?: number;
  /** Reject a `session/open` past this many sessions attached to one connection. */
  readonly maxSessions?: number;
  /** Reject an inbound frame larger than this (bytes) before parsing it. */
  readonly maxFrameBytes?: number;
  /**
   * Surface the real message + stack of a non-`RpcError` handler throw to the
   * client instead of an opaque "internal error". Only for a LOCAL, trusted
   * connection (the in-process worker) — NOT the remote ws-server. See
   * `RpcPeerOptions.exposeInternalErrors`.
   */
  readonly exposeInternalErrors?: boolean;
  /**
   * This connection serves the model (`--model-proxy`): when it goes away, the
   * turns of the sessions it is attached to are cancelled (their next model
   * call would fail obscurely) — the sessions themselves stay for re-attach.
   */
  readonly servesModel?: boolean;
}

/** One session this connection opened. */
interface Attached {
  readonly hosted: HostedSession;
  readonly attachment: Attachment;
}

export class Connection {
  private readonly peer: RpcPeer;
  private readonly host: SessionHost;
  private readonly attached = new Map<string, Attached>();
  private readonly maxSessions?: number;
  private readonly servesModel: boolean;
  private initialized = false;

  constructor(
    channel: DuplexChannel,
    host: SessionHost,
    onError?: (error: Error) => void,
    options: ConnectionOptions = {},
  ) {
    this.host = host;
    this.maxSessions = options.maxSessions;
    this.servesModel = options.servesModel === true;
    this.peer = new RpcPeer(channel, {
      onRequest: (method, params, context) => this.onRequest(method, params, context),
      onNotification: (method, params) => this.onNotification(method, params),
      // The only outbound daemon→client request is `session/request_permission`,
      // so this timeout is effectively the permission-answer deadline.
      ...(options.permissionTimeoutMs !== undefined
        ? { requestTimeoutMs: options.permissionTimeoutMs }
        : {}),
      ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
      ...(options.exposeInternalErrors ? { exposeInternalErrors: true } : {}),
      ...(onError ? { onError } : {}),
    });
  }

  /**
   * The connection went away: DETACH from every session — they keep running
   * (and keep their jobs) for a client to re-attach; only `session/close` (or
   * the process ending) stops them. Exception: a model-serving connection
   * cancels its sessions' turns, which cannot reach the model without it.
   */
  close(): void {
    for (const { hosted, attachment } of this.attached.values()) {
      if (this.servesModel) {
        hosted.cancel();
      }
      hosted.detach(attachment);
    }
    this.attached.clear();
    this.peer.close();
  }

  /**
   * Ask the connected client to run a model turn on our behalf (the pod
   * reverse-tunnel), batch cut: the client returns the whole turn's events in
   * one response. Outbound daemon→client request, like permission requests.
   */
  requestModelStream(request: WireChatRequest): Promise<ModelStreamResult> {
    return this.peer
      .request(Method.ModelStream, { request })
      .then((result) => result as ModelStreamResult);
  }

  /**
   * Ask the connected client to run a model turn on our behalf (the pod
   * reverse-tunnel), streaming the events as `$/progress` as they are produced
   * (the chunked cut). `signal` cancels it; `onProgress` receives each event
   * in `seq` order. Outbound daemon→client request, like permission requests.
   */
  requestModelStreamChunked(
    request: WireChatRequest,
    handlers: {
      readonly signal?: AbortSignal;
      readonly onProgress: (value: unknown, seq: number) => void;
    },
  ): Promise<ModelStreamChunkedResult> {
    return this.peer
      .request(Method.ModelStreamChunked, { request }, handlers)
      .then((result) => result as ModelStreamChunkedResult);
  }

  private async onRequest(
    method: string,
    params: unknown,
    context?: RequestContext,
  ): Promise<unknown> {
    if (method === Method.Initialize) {
      return this.initialize(params as InitializeParams);
    }
    if (!this.initialized) {
      throw new RpcError(DomainErrorCode.NotInitialized, "initialize before any other method");
    }
    switch (method) {
      case Method.Open:
        return this.open(params as OpenParams);
      case Method.Close:
        return this.closeSession(params as CloseParams);
      case Method.Prompt:
        return this.prompt(params as PromptParams);
      case Method.Compact:
        return this.compact(params as CompactParams, context?.signal);
      case Method.Snapshot:
        return this.snapshot(params as SnapshotParams);
      case Method.Enqueue:
        return this.enqueue(params as EnqueueParams);
      default:
        throw new RpcError(DomainErrorCode.NotInitialized, `unexpected method: ${method}`);
    }
  }

  private snapshot(params: SnapshotParams): SnapshotResult {
    const hosted = this.lookup(params.sessionId);
    return hosted.snapshotPage(params.cursor, params.limit);
  }

  // Synchronous on purpose: it pushes into the steering queue and returns at
  // once (AGENTS §7 — requests dispatch concurrently). The model sees the text
  // at the next model-round boundary, which streams back as a `steer` update.
  // Idempotency and the "this turn is running" check live in `HostedSession`.
  private enqueue(params: EnqueueParams): EnqueueResult {
    const hosted = this.lookup(params.sessionId);
    hosted.enqueue(params.id, params.turnId, params.text);
    return {};
  }

  // `signal` is the request's own: a `$/cancelRequest` for it stops the
  // compaction, like `session/cancel` does — the client was told "cancelled".
  private compact(params: CompactParams, signal?: AbortSignal): Promise<CompactResult> {
    const hosted = this.lookup(params.sessionId);
    return hosted.compact(signal);
  }

  private initialize(params: InitializeParams): InitializeResult {
    if (this.initialized) {
      throw new RpcError(DomainErrorCode.AlreadyInitialized, "already initialized");
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        DomainErrorCode.VersionMismatch,
        `protocol version mismatch: client ${params.protocolVersion}, daemon ${PROTOCOL_VERSION}`,
      );
    }
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { tools: true, permissions: true },
    };
  }

  /**
   * A session this connection opened, still the live one under that id. The
   * identity check catches "closed (by anyone) and recreated under the same id":
   * this connection must not silently drive the new session, whose stream it
   * does not receive. Commands need an `open` first, for the same reason.
   */
  private lookup(sessionId: string): HostedSession {
    const entry = this.attached.get(sessionId);
    if (entry && this.host.get(sessionId) === entry.hosted) {
      return entry.hosted;
    }
    this.dropStale();
    throw new RpcError(
      DomainErrorCode.UnknownSession,
      `unknown session: ${sessionId} (not open on this connection)`,
    );
  }

  // Synchronous on purpose, like the host's `open` it wraps (see there): no
  // update falls between the replay and the live stream, and two opens of one
  // id never build two agents. The replay goes out as notifications BEFORE the
  // response.
  private open(params: OpenParams): OpenResult {
    // A session closed by another client must not count against this
    // connection's cap, nor stay referenced here.
    this.dropStale();
    const previous =
      params.sessionId !== undefined ? this.attached.get(params.sessionId) : undefined;
    if (!previous && this.maxSessions !== undefined && this.attached.size >= this.maxSessions) {
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many sessions on this connection (max ${this.maxSessions})`,
      );
    }
    // A retried open from this connection: drop the old attachment first, or
    // every update would arrive twice.
    if (previous && params.sessionId !== undefined) {
      previous.hosted.detach(previous.attachment);
      this.attached.delete(params.sessionId);
    }
    const attachment: Attachment = {
      send: (update) => this.peer.notify(Notification.SessionUpdate, update),
      requestPermission: (pp) => this.requestPermission(pp),
    };
    const { hosted, created, resync, epoch } = this.host.open(params, attachment);
    this.attached.set(hosted.id, { hosted, attachment });
    return { sessionId: hosted.id, epoch, created, resync };
  }

  /** Forget every attachment whose session is no longer the live one under its id. */
  private dropStale(): void {
    for (const [id, entry] of this.attached) {
      if (this.host.get(id) !== entry.hosted) {
        entry.hosted.detach(entry.attachment);
        this.attached.delete(id);
      }
    }
  }

  // Needs no `open` (an exit path closes what it may never have re-opened);
  // an unknown id is a no-op success.
  private closeSession(params: CloseParams): CloseResult {
    this.attached.delete(params.sessionId);
    this.host.close(params.sessionId);
    return {};
  }

  // Acks at once: the turn runs daemon-side and ends with `turn_end` in the
  // stream, so its outcome survives a lost response.
  private prompt(params: PromptParams): PromptResult {
    const hosted = this.lookup(params.sessionId);
    return hosted.prompt(params.turnId, params.content);
  }

  private requestPermission(
    params: RequestPermissionParams,
  ): Promise<RequestPermissionResult["outcome"]> {
    // A timed-out, closed, or malformed permission reply must fail safe: treat
    // it as a cancellation (→ `allowed: false`), never leave the turn hung or
    // let the tool run unapproved.
    return this.peer
      .request(Method.RequestPermission, params)
      .then((result) => (result as RequestPermissionResult).outcome)
      .catch((): RequestPermissionResult["outcome"] => ({ outcome: "cancelled" }));
  }

  private onNotification(method: string, params: unknown): void {
    if (method === Notification.Cancel) {
      const { sessionId } = params as CancelParams;
      const entry = this.attached.get(sessionId);
      if (entry && this.host.get(sessionId) === entry.hosted) {
        entry.hosted.cancel();
      }
    }
  }
}
