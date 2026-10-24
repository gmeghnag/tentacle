/**
 * One client connection: an `RpcPeer` bound to a `SessionHost`. Handles the
 * handshake and the `session/*` methods, holds this client's ATTACHMENTS to the
 * host's sessions (each streams `session/update` notifications here — permission
 * requests included, answered with `session/resolve_permission`), and detaches
 * them — never ends a session — when the connection goes away.
 *
 * Methods other than `initialize` are refused until the handshake completes, and
 * an incompatible protocol major is rejected — security/versioning live here.
 */
import type { AskHooksTrust } from "@tentacle/agent";
import {
  type CancelParams,
  type CloseParams,
  type CloseResult,
  type CompactParams,
  type CompactResult,
  type DeleteParams,
  type DeleteResult,
  type EnqueueParams,
  type EnqueueResult,
  type HooksTrustResult,
  type InitializeParams,
  type InitializeResult,
  type McpStatusResult,
  Method,
  type ModelPurpose,
  type ModelStreamChunkedResult,
  type ModelStreamResult,
  Notification,
  type OpenParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptParams,
  type PromptResult,
  type RenameParams,
  type RenameResult,
  type ResolvePermissionParams,
  type ResolvePermissionResult,
  type SendNowParams,
  type SessionListParams,
  type SessionTtlParams,
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
import { versionMismatch } from "./version-mismatch.ts";

/**
 * Per-connection resource limits (the daemon's exposure boundary sets these).
 * Session counts are daemon-wide, on `SessionHost`: sessions outlive connections.
 */
export interface ConnectionOptions {
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
  private readonly servesModel: boolean;
  private initialized = false;
  /** The update types the client declared at `initialize`; undefined = the v10 base set. */
  private updateTypes: readonly string[] | undefined;

  constructor(
    channel: DuplexChannel,
    host: SessionHost,
    onError?: (error: Error) => void,
    options: ConnectionOptions = {},
  ) {
    this.host = host;
    this.servesModel = options.servesModel === true;
    this.peer = new RpcPeer(channel, {
      onRequest: (method, params, context) => this.onRequest(method, params, context),
      onNotification: (method, params) => this.onNotification(method, params),
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
   * one response. Outbound daemon→client request (the only kind, with the chunked cut).
   * `purpose` marks a non-turn call (a title): the CLIENT picks its model.
   */
  requestModelStream(request: WireChatRequest, purpose?: ModelPurpose): Promise<ModelStreamResult> {
    return this.peer
      .request(Method.ModelStream, { request, ...(purpose ? { purpose } : {}) })
      .then((result) => result as ModelStreamResult);
  }

  /**
   * Ask the connected client to run a model turn on our behalf (the pod
   * reverse-tunnel), streaming the events as `$/progress` as they are produced
   * (the chunked cut). `signal` cancels it; `onProgress` receives each event
   * in `seq` order. Outbound daemon→client request. `purpose`: as `requestModelStream`.
   */
  requestModelStreamChunked(
    request: WireChatRequest,
    handlers: {
      readonly signal?: AbortSignal;
      readonly onProgress: (value: unknown, seq: number) => void;
    },
    purpose?: ModelPurpose,
  ): Promise<ModelStreamChunkedResult> {
    return this.peer
      .request(Method.ModelStreamChunked, { request, ...(purpose ? { purpose } : {}) }, handlers)
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
      case Method.SessionDelete:
        return this.deleteSession(params as DeleteParams);
      case Method.Prompt:
        return this.prompt(params as PromptParams);
      case Method.Compact:
        return this.compact(params as CompactParams, context?.signal);
      case Method.Snapshot:
        return this.snapshot(params as SnapshotParams);
      case Method.Enqueue:
        return this.enqueue(params as EnqueueParams);
      case Method.SendNow:
        return this.sendNow(params as SendNowParams);
      case Method.ResolvePermission:
        return this.resolvePermission(params as ResolvePermissionParams);
      case Method.McpStatus:
        return this.mcpStatus();
      case Method.SkillsList:
        return this.host.skillList;
      // A read of the registry: does not attach this connection to anything.
      case Method.SessionList:
        return this.host.list(params as SessionListParams);
      // Host-level, like `close`: needs no `open` here (an archived session can be renamed).
      case Method.Rename: {
        const { sessionId, title } = params as RenameParams;
        return { title: this.host.rename(sessionId, title) } satisfies RenameResult;
      }
      // Daemon-wide: reads/sets the reaper's TTL, attaches this connection to nothing.
      case Method.SessionTtl:
        return this.host.sessionTtl(params as SessionTtlParams);
      default:
        throw new RpcError(DomainErrorCode.NotInitialized, `unexpected method: ${method}`);
    }
  }

  // A live probe (up to its ping timeout): concurrent with every other request,
  // like all handlers here (AGENTS §7) — never awaited under a lock.
  private async mcpStatus(): Promise<McpStatusResult> {
    return { servers: [...(await this.host.mcpStatus())] };
  }

  private snapshot(params: SnapshotParams): SnapshotResult {
    const hosted = this.lookup(params.sessionId);
    return hosted.snapshotPage(params.cursor, params.limit);
  }

  // The push into the steering queue is synchronous (AGENTS §7 — requests
  // dispatch concurrently; the running check and the push are one step). The
  // model sees the text at the next model-round boundary, which streams back as
  // a `steer` update. Idempotency and the "this turn is running" check live in
  // `HostedSession`. Only the ACK waits: on `serve`, until the steer is on disk
  // (an acked steer survives a restart); elsewhere it is immediate. A failed
  // write does not fail the ack — the steer is queued; the daemon log has it.
  private async enqueue(params: EnqueueParams): Promise<EnqueueResult> {
    const hosted = this.lookup(params.sessionId);
    hosted.enqueue(params.id, params.turnId, params.text);
    await hosted.persisted();
    return {};
  }

  // `signal` is the request's own: a `$/cancelRequest` for it stops the
  // compaction, like `session/cancel` does — the client was told "cancelled".
  private compact(params: CompactParams, signal?: AbortSignal): Promise<CompactResult> {
    const hosted = this.lookup(params.sessionId);
    return hosted.compact(signal);
  }

  // Synchronous, like `enqueue`'s push: the first valid answer settles the
  // request in this step (first-wins lives in `HostedSession`); a loser gets
  // `PermissionNotPending` and learns the outcome from `permission_resolved`.
  private resolvePermission(params: ResolvePermissionParams): ResolvePermissionResult {
    const hosted = this.lookup(params.sessionId);
    hosted.resolvePermission(params.requestId, params.optionId);
    return {};
  }

  private initialize(params: InitializeParams): InitializeResult {
    if (this.initialized) {
      throw new RpcError(DomainErrorCode.AlreadyInitialized, "already initialized");
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      // Worded from facts, with `data` ALWAYS: a client deduces "the daemon
      // predates this" from its absence (docs/feat/version-mismatch-notice.md).
      const { message, data } = versionMismatch(
        {
          protocol: params.protocolVersion,
          ...(params.clientInfo
            ? { tentacle: params.clientInfo.version, name: params.clientInfo.name }
            : {}),
        },
        {
          protocol: PROTOCOL_VERSION,
          ...(this.host.identity ? { identity: this.host.identity } : {}),
        },
      );
      throw new RpcError(DomainErrorCode.VersionMismatch, message, data);
    }
    this.initialized = true;
    // The update types this client understands (protocol 10): gates BLOCKING
    // ones per attachment (docs/feat/protocol-v10-forward-compat.md).
    if (params.clientCapabilities.updates) {
      this.updateTypes = params.clientCapabilities.updates;
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { tools: true, permissions: true },
      skills: [...this.host.skillCatalog],
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

  // One await FIRST — an explicit reopen of an archived session may read its
  // record from disk (`prepareOpen`; no lock: other requests run meanwhile) —
  // then a synchronous body, like the host's `open` it wraps (see there): no
  // update falls between the replay and the live stream, and two opens of one
  // id never build two agents (the host re-checks live / archived there). The
  // replay goes out as notifications BEFORE the response.
  private async open(params: OpenParams): Promise<OpenResult> {
    const prepared = await this.host.prepareOpen(params);
    // A session closed by another client must not stay referenced here.
    this.dropStale();
    const previous =
      params.sessionId !== undefined ? this.attached.get(params.sessionId) : undefined;
    // A retried open from this connection: drop the old attachment first, or
    // every update would arrive twice.
    if (previous && params.sessionId !== undefined) {
      previous.hosted.detach(previous.attachment);
      this.attached.delete(params.sessionId);
    }
    const attachment: Attachment = {
      send: (update) => this.peer.notify(Notification.SessionUpdate, update),
      ...(this.updateTypes ? { updates: this.updateTypes } : {}),
    };
    const { hosted, created, resync, epoch } = this.host.open(params, attachment, prepared);
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

  // Like `close`: needs no `open`; an unknown id is a no-op success. Attached
  // clients (this one included) get `session_closed{deleted}` first.
  private deleteSession(params: DeleteParams): DeleteResult {
    this.attached.delete(params.sessionId);
    this.host.delete(params.sessionId);
    return {};
  }

  // Acks at once: the turn runs daemon-side and ends with `turn_end` in the
  // stream, so its outcome survives a lost response.
  private prompt(params: PromptParams): PromptResult {
    const hosted = this.lookup(params.sessionId);
    // The PROMPTING connection is asked about project hooks: it is the client
    // with a human behind this turn (docs/feat/hooks-project-trust.md). The
    // laptop decides; a rejection (an old laptop's `MethodNotFound`, a drop)
    // is "declined" in the runner.
    return hosted.prompt(params.turnId, params.content, params.skill, this.askHooksTrust);
  }

  // Acks at once, like `prompt`: the cancel and the new turn happen daemon-side
  // in one step; the new turn is asked about hooks through THIS connection.
  private sendNow(params: SendNowParams): PromptResult {
    const hosted = this.lookup(params.sessionId);
    return hosted.sendNow(params.turnId, params.interrupt, params.messages, this.askHooksTrust);
  }

  private readonly askHooksTrust: AskHooksTrust = (request, signal) =>
    this.peer
      .request(Method.HooksTrust, request, signal ? { signal } : undefined)
      .then((result) => (result as HooksTrustResult).trusted === true);

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
