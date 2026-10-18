/**
 * One client connection: an `RpcPeer` bound to a `SessionHost`. Handles the
 * handshake and the `session/*` methods, streams `session/update` notifications
 * for each turn, and routes the agent's permission requests back to this client.
 *
 * Methods other than `initialize` are refused until the handshake completes, and
 * an incompatible protocol major is rejected — security/versioning live here.
 */
import {
  type CancelParams,
  type CompactParams,
  type CompactResult,
  type InitializeParams,
  type InitializeResult,
  Method,
  type ModelStreamChunkedResult,
  type ModelStreamResult,
  type NewSessionParams,
  type NewSessionResult,
  Notification,
  PROTOCOL_VERSION,
  type PromptParams,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SnapshotParams,
  type SnapshotResult,
  type WireChatRequest,
} from "@tentacle/protocol";
import { DomainErrorCode, type DuplexChannel, RpcError, RpcPeer } from "@tentacle/transport";
import type { HostedSession } from "./hosted-session.ts";
import type { SessionHost } from "./session-host.ts";

/** Per-connection resource limits (the daemon's exposure boundary sets these). */
export interface ConnectionOptions {
  /** Auto-deny a `session/request_permission` the client leaves unanswered this long. */
  readonly permissionTimeoutMs?: number;
  /** Reject a `session/new` past this many live sessions on one connection. */
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
}

export class Connection {
  private readonly peer: RpcPeer;
  private readonly host: SessionHost;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly maxSessions?: number;
  private initialized = false;

  constructor(
    channel: DuplexChannel,
    host: SessionHost,
    onError?: (error: Error) => void,
    options: ConnectionOptions = {},
  ) {
    this.host = host;
    this.maxSessions = options.maxSessions;
    this.peer = new RpcPeer(channel, {
      onRequest: (method, params) => this.onRequest(method, params),
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

  close(): void {
    for (const session of this.sessions.values()) {
      session.cancel();
    }
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

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === Method.Initialize) {
      return this.initialize(params as InitializeParams);
    }
    if (!this.initialized) {
      throw new RpcError(DomainErrorCode.NotInitialized, "initialize before any other method");
    }
    switch (method) {
      case Method.NewSession:
        return this.newSession(params as NewSessionParams);
      case Method.Prompt:
        return this.prompt(params as PromptParams);
      case Method.Compact:
        return this.compact(params as CompactParams);
      case Method.Snapshot:
        return this.snapshot(params as SnapshotParams);
      default:
        throw new RpcError(DomainErrorCode.NotInitialized, `unexpected method: ${method}`);
    }
  }

  private snapshot(params: SnapshotParams): SnapshotResult {
    const hosted = this.sessions.get(params.sessionId);
    if (!hosted) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    // core `ChatMessage` is structurally the wire schema; copy to a mutable array.
    return { messages: [...hosted.snapshot().messages] } as SnapshotResult;
  }

  private compact(params: CompactParams): Promise<CompactResult> {
    const hosted = this.sessions.get(params.sessionId);
    if (!hosted) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    return hosted.compact();
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

  private newSession(params: NewSessionParams): NewSessionResult {
    if (this.maxSessions !== undefined && this.sessions.size >= this.maxSessions) {
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many sessions on this connection (max ${this.maxSessions})`,
      );
    }
    const id = params.sessionId ?? crypto.randomUUID();
    const hosted = this.host.create(
      id,
      params.cwd,
      (pp) => this.requestPermission(pp),
      params.messages,
    );
    hosted.setSink((update) => this.peer.notify(Notification.SessionUpdate, update));
    this.sessions.set(id, hosted);
    return { sessionId: id };
  }

  private async prompt(params: PromptParams): Promise<PromptResult> {
    const hosted = this.sessions.get(params.sessionId);
    if (!hosted) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    const stopReason = await hosted.prompt(params.content);
    return { stopReason };
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
      this.sessions.get(sessionId)?.cancel();
    }
  }
}
