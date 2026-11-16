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
  type AgentKillParams,
  type AttachmentPutParams,
  type CancelParams,
  type ClearParams,
  type ClearResult,
  type CloseParams,
  type CloseResult,
  type CompactParams,
  type CompactResult,
  type DaemonDiscovery,
  type DeleteParams,
  type DeleteResult,
  type DetachParams,
  type DetachResult,
  type DeviceLiveActivityEndedParams,
  type DeviceLiveActivityEndedResult,
  type DeviceLiveActivityRegisterParams,
  type DeviceLiveActivityRegisterResult,
  type DeviceLiveActivityTokenParams,
  type DeviceLiveActivityTokenResult,
  type DevicePairParams,
  type DevicePairResult,
  type DevicePushRegisterParams,
  type DevicePushRegisterResult,
  type DevicePushUnregisterParams,
  type DevicePushUnregisterResult,
  type EnqueueParams,
  type EnqueueResult,
  type HooksTrustParams,
  type HooksTrustResult,
  type InitializeParams,
  type InitializeResult,
  type JobKillParams,
  type JobOutputParams,
  type LogParams,
  type McpStatusResult,
  Method,
  type ModelCountTokensResult,
  type ModelPurpose,
  type ModelStreamChunkedResult,
  type ModelStreamResult,
  Notification,
  type OpenParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type PromptParams,
  type PromptResult,
  type ReclaimParams,
  type ReclaimResult,
  type RenameParams,
  type RenameResult,
  type ResolvePermissionParams,
  type ResolvePermissionResult,
  type ScheduleDeleteParams,
  type SendNowParams,
  type SessionContextParams,
  type SessionContextResult,
  type SessionListParams,
  type SessionSkillsParams,
  type SessionSkillsResult,
  type SessionTtlParams,
  type SetAutoAcceptParams,
  type SetCapabilityParams,
  type SnapshotParams,
  type SnapshotResult,
  type SubagentMessageParams,
  type SubagentMessageResult,
  type UnwatchParams,
  type UnwatchResult,
  type UpdateSettingsParams,
  WAKE_TURN_PREFIX,
  type WatchNextParams,
  type WatchNextResult,
  type WatchParams,
  type WatchResult,
  type WireChatRequest,
  isWakeTurnId,
} from "@tentacle/protocol";
import {
  DomainErrorCode,
  type DuplexChannel,
  ErrorCode,
  type RequestContext,
  RpcError,
  RpcPeer,
} from "@tentacle/transport";
import type { Attachment, HostedSession } from "./hosted-session.ts";
import { type PairHandler, pairingRefusedError } from "./pairing-handler.ts";
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
   * This connection serves the model (`--model-proxy`): the sessions it opens
   * may send their model calls through it (`HostedSession.modelLink`, the most
   * recently attached serving connection wins). When the LAST serving
   * connection of a session goes away, its turn is cancelled (its next model
   * call would fail obscurely) — the session itself stays for re-attach.
   */
  readonly servesModel?: boolean;
  /**
   * WHO this connection is (docs/feat/device-pairing.md 9b/9c). Absent = a token
   * client, today's behaviour: every method. A `device` has exactly the same
   * rights (one user, many devices — decision 5): the socket's key already
   * decided it, and revocation lives in the ws-server's per-device map, not
   * here. A `pairing` connection may do ONE thing — `device/pair` (9c) — and
   * `initialize`; everything else is `Unauthorized`, which is what makes an
   * unregistered peer during a pairing window harmless (F16). Its `pair`
   * handler is per connection: the attempt cap belongs to the socket.
   */
  readonly principal?: ConnectionPrincipal;
  /**
   * The HOST's own answer for project hooks, checked BEFORE the prompting
   * client is asked (docs/feat/serve-mcp.md S4): `trusted` = this folder and
   * this hooks hash are already trusted on the machine the daemon runs on, so
   * no client is bothered and no lasting approval is created from a remote's
   * answer; `declined` = that machine's own explicit `never`, which is a
   * decision about the FOLDER and is not overridable from a phone ("ask" is
   * what the prompting client sees). Read-only: it answers early, it never
   * grants (AGENTS §7, never let a pod-originated prompt create a lasting
   * approval).
   */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
}

/**
 * A host's own project-hooks answer before any client is asked (S4):
 * `trusted` / `declined` are the host's decisions, `ask` defers to the client.
 */
export type HooksTrustPrecheck = (
  request: Pick<HooksTrustParams, "folder" | "hash">,
) => "trusted" | "declined" | "ask";

/**
 * A connection's authenticated role, decided once at the handshake — never
 * upgraded in place (a privilege is a property of the socket, §7).
 */
export type ConnectionPrincipal =
  | { readonly kind: "token" }
  | { readonly kind: "device"; readonly id: string }
  /** An unregistered key admitted during a pairing window: only `device/pair`. */
  | { readonly kind: "pairing"; readonly pair: PairHandler };

/** The two tunnel requests of a model-serving connection (the pod reverse-tunnel). */
export type ModelLink = Pick<Connection, "requestModelStream" | "requestModelStreamChunked"> &
  Partial<Pick<Connection, "requestModelCountTokens">>;

/** One session this connection opened. */
interface Attached {
  readonly hosted: HostedSession;
  readonly attachment: Attachment;
}

/**
 * One session this connection WATCHES (docs/feat/logs-cmd.md sub-task 2): a
 * read-only follower. It is deliberately NOT in `attached` — no attachment
 * exists, so it cannot become a model link, answer an ask or count in
 * `session/list`'s `attached`.
 */
interface Watched {
  readonly hosted: HostedSession;
  readonly watchId: string;
}

export class Connection {
  private readonly peer: RpcPeer;
  private readonly host: SessionHost;
  private readonly principal: ConnectionPrincipal;
  private readonly attached = new Map<string, Attached>();
  /** This connection's watchers, by `watchId`; released when it goes away. */
  private readonly watches = new Map<string, Watched>();
  /** The `daemon/discovery` subscription of THIS connection (at most one, F13). */
  private discoveryUnsubscribe: (() => void) | undefined;
  private readonly servesModel: boolean;
  /** The host's own project-hooks answer, before any client is asked (S4). */
  private readonly hooksTrustPrecheck: HooksTrustPrecheck | undefined;
  private initialized = false;
  /** The update types the client declared at `initialize`; undefined = the v10 base set. */
  private updateTypes: readonly string[] | undefined;
  /**
   * This connection's client declared `hop` (D8/D9): it can ask its owner about a
   * `move_session` proposal. Read once at `initialize`; a session this connection
   * CREATES is offered the tool only then, so a pod daemon serving a `run`/`attach`
   * TUI never lets the model propose a move nobody is asked about.
   */
  private hop = false;
  /**
   * The label `auto_accept` carries as `by`: this connection's declared host
   * (slice 6) or else its `clientInfo.name`, read once at `initialize` — never
   * client-chosen per call, so the text a client shows is the daemon's own
   * reading of who set the switch (display only, untrusted).
   */
  private autoAcceptBy: string | undefined;
  /**
   * This connection's declared device name (`ClientInfo.host`), stamped into
   * every ask's `askedOn` (docs/feat/session-auto-accept.md D7). Display only.
   */
  private clientHost: string | undefined;

  constructor(
    channel: DuplexChannel,
    host: SessionHost,
    onError?: (error: Error) => void,
    options: ConnectionOptions = {},
  ) {
    this.host = host;
    this.servesModel = options.servesModel === true;
    this.principal = options.principal ?? { kind: "token" };
    this.hooksTrustPrecheck = options.hooksTrustPrecheck;
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
   * the process ending) stops them. Exception: the last model-serving
   * connection of a session cancels its turn, which cannot reach the model
   * without one.
   */
  close(): void {
    for (const entry of this.attached.values()) {
      this.release(entry);
    }
    this.attached.clear();
    // A watch leaves no state on the session (nothing was attached); releasing
    // it stops the queue's timer and ends a held poll. Never a session change.
    for (const watch of this.watches.values()) {
      watch.hosted.unwatch(watch.watchId);
    }
    this.watches.clear();
    // The ONE teardown (P3): the poller stops at zero subscribers, so nothing
    // is left running for a connection that is gone (F11).
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = undefined;
    this.peer.close();
  }

  /** Stop listening to one session (a close's or a `session/detach`'s per-session step). */
  private release({ hosted, attachment }: Attached): void {
    hosted.detach(attachment);
    // Another serving connection still attached takes the next model call
    // (protocol 14); with none left, the turn could not reach the model.
    if (this.servesModel && hosted.modelLink() === null) {
      hosted.cancel();
    }
  }

  /**
   * Ask the connected client to run a model turn on our behalf (the pod
   * reverse-tunnel), batch cut: the client returns the whole turn's events in
   * one response. Outbound daemon→client request (the only kind, with the chunked cut).
   * `purpose` marks a non-turn call (a title): the CLIENT picks its model.
   * `model`: a name the laptop published (docs/feat/models-map-pod.md); the
   * laptop decides whether to serve it, this side only asks.
   */
  requestModelStream(
    request: WireChatRequest,
    purpose?: ModelPurpose,
    model?: string,
  ): Promise<ModelStreamResult> {
    return this.peer
      .request(Method.ModelStream, {
        request,
        ...(purpose ? { purpose } : {}),
        ...(model !== undefined ? { model } : {}),
      })
      .then((result) => result as ModelStreamResult);
  }

  /**
   * Ask the connected client to run a model turn on our behalf (the pod
   * reverse-tunnel), streaming the events as `$/progress` as they are produced
   * (the chunked cut). `signal` cancels it; `onProgress` receives each event
   * in `seq` order. Outbound daemon→client request. `purpose`, `model`: as
   * `requestModelStream`.
   */
  requestModelStreamChunked(
    request: WireChatRequest,
    handlers: {
      readonly signal?: AbortSignal;
      readonly onProgress: (value: unknown, seq: number) => void;
    },
    purpose?: ModelPurpose,
    model?: string,
  ): Promise<ModelStreamChunkedResult> {
    return this.peer
      .request(
        Method.ModelStreamChunked,
        {
          request,
          ...(purpose ? { purpose } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        handlers,
      )
      .then((result) => result as ModelStreamChunkedResult);
  }

  /**
   * Ask the connected client to count a request's prompt with its LOCAL
   * provider, without generating (`model/countTokens`, the pod reverse-tunnel:
   * the model and its key stay on the laptop). Outbound daemon→client request;
   * an older client answers `MethodNotFound`. `signal` cancels it (a
   * `$/cancelRequest` reaches the laptop, which aborts its provider's fetch).
   */
  requestModelCountTokens(
    request: WireChatRequest,
    signal?: AbortSignal,
  ): Promise<ModelCountTokensResult> {
    return this.peer
      .request(Method.ModelCountTokens, { request }, signal ? { signal } : undefined)
      .then((result) => result as ModelCountTokensResult);
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
    if (method === Method.DevicePair) {
      return this.devicePair(this.principal, params as DevicePairParams, context?.signal);
    }
    // A pairing connection may do exactly nothing else (F16): its peer is an
    // UNREGISTERED key, admitted only so it can prove the one-time code. The
    // method gate is here, on the daemon's own side (never the pod's, never
    // the client's).
    if (this.principal.kind === "pairing") {
      throw new RpcError(
        DomainErrorCode.Unauthorized,
        "a pairing connection may only call device/pair",
      );
    }
    switch (method) {
      case Method.Open:
        return this.open(params as OpenParams);
      case Method.Close:
        return this.closeSession(params as CloseParams);
      case Method.Detach:
        return this.detachSession(params as DetachParams);
      case Method.SessionDelete:
        return this.deleteSession(params as DeleteParams);
      case Method.Prompt:
        return this.prompt(params as PromptParams);
      case Method.Compact:
        return this.compact(params as CompactParams, context?.signal);
      // Synchronous, holds no lock (AGENTS §7): `HostedSession.clear` never awaits.
      case Method.Clear:
        return this.clear(params as ClearParams);
      // Synchronous from the idle check to the agent swap; holds no lock (AGENTS §7).
      case Method.UpdateSettings: {
        const { sessionId, id, settings } = params as UpdateSettingsParams;
        return this.host.updateSettings(this.lookup(sessionId), id, settings);
      }
      // Synchronous, holds no lock (AGENTS §7): it never awaits a turn, and the
      // fan-out is synchronous, so two sets keep one total order (P2).
      case Method.SetAutoAccept: {
        const { sessionId, on } = params as SetAutoAcceptParams;
        return this.lookup(sessionId).setAutoAccept(on, this.autoAcceptBy);
      }
      // Same shape (docs/feat/session-capabilities.md F4): synchronous, no lock,
      // one total order. Every daemon holds it, a pod included: it only REMOVES
      // what that daemon's own model is offered, so nothing is gated laptop-side.
      case Method.SetCapability: {
        const { sessionId, kind, name, enabled } = params as SetCapabilityParams;
        return this.lookup(sessionId).setCapability({ kind, name, enabled }, this.autoAcceptBy);
      }
      case Method.Snapshot:
        return this.snapshot(params as SnapshotParams);
      // Synchronous, served from the derived log: no lock, no await (AGENTS §7).
      // Also allowed for a session this connection only WATCHES (a `logs -f`
      // --tail cold read, sub-task 2): reading the committed log needs no open.
      case Method.Log: {
        const { sessionId, after, maxChars } = params as LogParams;
        return this.readable(sessionId).logRead(after, maxChars);
      }
      case Method.Enqueue:
        return this.enqueue(params as EnqueueParams);
      case Method.SendNow:
        return this.sendNow(params as SendNowParams);
      case Method.Reclaim:
        return this.reclaim(params as ReclaimParams);
      case Method.ResolvePermission:
        return this.resolvePermission(params as ResolvePermissionParams);
      // Both synchronous, holding no lock (AGENTS §7): they never await a turn.
      case Method.SubagentMessage: {
        const { sessionId, agentId, text } = params as SubagentMessageParams;
        return this.messageSubagent(this.lookup(sessionId), agentId, text);
      }
      case Method.AgentKill: {
        const { sessionId, agentId } = params as AgentKillParams;
        return this.lookup(sessionId).killSubagent(agentId);
      }
      // Likewise synchronous from the registry (AGENTS §7): a UI's read of one
      // job's tail, and the user's stop of one shell job.
      case Method.JobOutput: {
        const { sessionId, jobId, lines, maxChars } = params as JobOutputParams;
        return this.lookup(sessionId).jobOutput(jobId, { lines, maxChars });
      }
      case Method.JobKill: {
        const { sessionId, jobId } = params as JobKillParams;
        return this.lookup(sessionId).jobKill(jobId);
      }
      case Method.ScheduleDelete: {
        // Synchronous (docs/feat/cron-tool.md D5): never waits on a turn.
        const { sessionId, scheduleId } = params as ScheduleDeleteParams;
        return this.lookup(sessionId).deleteSchedule(scheduleId);
      }
      case Method.McpStatus:
        return this.mcpStatus();
      case Method.SessionSkills:
        return this.sessionSkills(params as SessionSkillsParams);
      case Method.SessionContext:
        return this.sessionContext(params as SessionContextParams, context?.signal);
      // Synchronous from the offset check to the append, holding no lock
      // (AGENTS §7): a store `put` that awaited would let two chunks of one
      // blob interleave at the same offset. The store belongs to the SESSION,
      // not this connection, so a re-attach resumes where it stopped. A `serve`
      // store returns a PROMISE for a verified last chunk (the ack waits for the
      // file to be durable, docs/feat/attachments-durable.md D2) — after its
      // synchronous prefix, so returning it here serializes nothing.
      case Method.AttachmentPut: {
        const { sessionId, ...chunk } = params as AttachmentPutParams;
        return this.lookup(sessionId).uploads.put(chunk);
      }
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
      // A read-only follower (docs/feat/logs-cmd.md sub-task 2). `watch` and
      // `unwatch` are synchronous and attach nothing; `watch_next` HOLDS its
      // request — which blocks no other handler, because the peer dispatches
      // every inbound request concurrently (AGENTS §7).
      case Method.Watch:
        return this.watchSession(params as WatchParams);
      case Method.WatchNext:
        return this.watchNext(params as WatchNextParams);
      case Method.Unwatch:
        return this.unwatch(params as UnwatchParams);
      // Daemon-wide: this computer's live siblings and their addresses. It also
      // SUBSCRIBES this connection to `daemon/discovery` — the notification is
      // never sent unsolicited (an unknown one reaches an older client's
      // `onError`, docs/feat/sibling-discovery.md). Synchronous: subscribe,
      // then snapshot, nothing awaited (AGENTS §7).
      case Method.DaemonDiscover:
        return this.discover();
      // Push registration (docs/feat/mobile-push.md Design 3, slice P7): a DEVICE's
      // own business — the token and the push key are its, and the connection's
      // principal is what names it. A `token` or `pairing` connection gets the
      // usual refusal (the gate above), so a pod-facing plain client can never
      // register a token this computer would push to.
      //
      // Both are synchronous (one atomic rename / one unlink) and hold no lock:
      // a registration must never queue behind a long `session/prompt` (AGENTS §7
      // "don't serialize the RPC peer").
      case Method.DevicePushRegister: {
        if (this.principal.kind !== "device") {
          throw new RpcError(
            DomainErrorCode.Unauthorized,
            "only a paired device may register for push",
          );
        }
        return this.host.registerPush(
          this.principal.id,
          params as DevicePushRegisterParams,
        ) satisfies DevicePushRegisterResult;
      }
      case Method.DevicePushUnregister: {
        if (this.principal.kind !== "device") {
          throw new RpcError(
            DomainErrorCode.Unauthorized,
            "only a paired device may unregister for push",
          );
        }
        this.host.unregisterPush(this.principal.id);
        return {} satisfies DevicePushUnregisterResult;
      }
      // Live Activities (docs/feat/mobile-live-activity.md Design 4, L7): the SAME
      // device-principal rule as push, for the same reason — a `token`/`pairing`
      // connection is refused above, so a pod-facing plain client can never place
      // a token that lights up a lock screen. All three are synchronous and hold
      // no lock (AGENTS §7 "don't serialize the RPC peer").
      case Method.DeviceLiveActivityRegister: {
        if (this.principal.kind !== "device") {
          throw new RpcError(
            DomainErrorCode.Unauthorized,
            "only a paired device may register for live activities",
          );
        }
        return this.host.registerLiveActivity(
          this.principal.id,
          params as DeviceLiveActivityRegisterParams,
        ) satisfies DeviceLiveActivityRegisterResult;
      }
      case Method.DeviceLiveActivityToken: {
        if (this.principal.kind !== "device") {
          throw new RpcError(
            DomainErrorCode.Unauthorized,
            "only a paired device may report an activity token",
          );
        }
        return this.host.setLiveActivityToken(
          this.principal.id,
          params as DeviceLiveActivityTokenParams,
        ) satisfies DeviceLiveActivityTokenResult;
      }
      case Method.DeviceLiveActivityEnded: {
        if (this.principal.kind !== "device") {
          throw new RpcError(
            DomainErrorCode.Unauthorized,
            "only a paired device may report an activity ended",
          );
        }
        return this.host.endLiveActivity(
          this.principal.id,
          params as DeviceLiveActivityEndedParams,
        ) satisfies DeviceLiveActivityEndedResult;
      }
      default:
        throw new RpcError(DomainErrorCode.NotInitialized, `unexpected method: ${method}`);
    }
  }

  // A live probe (up to its ping timeout): concurrent with every other request,
  // like all handlers here (AGENTS §7) — never awaited under a lock.
  private async mcpStatus(): Promise<McpStatusResult> {
    return { servers: [...(await this.host.mcpStatus())] };
  }

  /**
   * `daemon/discover`: subscribe this connection to changes, THEN return the
   * snapshot — in that order, so no change can fall between the two (F12; the
   * client's `rev` guard covers a frame that overtakes the response). A second
   * call REPLACES the subscription rather than adding one (F13). Synchronous:
   * one listener registration plus a cached read, nothing awaited, so a long
   * `session/prompt` on this connection never delays it (AGENTS §7).
   */
  private discover(): DaemonDiscovery {
    const source = this.host.discoverySource();
    this.discoveryUnsubscribe?.();
    const unsubscribe = source.subscribe((discovery) => {
      // Fire-and-forget: `notify` on a closed peer is a no-op (P4), so a change
      // racing a disconnect cannot throw here.
      this.peer.notify(Notification.DaemonDiscovery, discovery);
    });
    this.discoveryUnsubscribe = unsubscribe;
    return source.current();
  }

  // The count may take up to its cap (a couple of seconds); like every request
  // it is concurrent with the others and holds no lock. No session id → the
  // conversation a session created now would send (the `messages` seed of a
  // resume, else the fresh one), counted through THIS connection's model link
  // (a pod daemon reaches the model only through it).
  private sessionContext(
    params: SessionContextParams,
    signal?: AbortSignal,
  ): Promise<SessionContextResult> {
    if (params.sessionId === undefined) {
      return this.host.newSessionContext(
        this.servesModel ? this : null,
        signal,
        params.messages,
        params.settings,
      );
    }
    return this.lookup(params.sessionId).context(signal);
  }

  // A disk scan: concurrent with every other request (AGENTS §7), never under
  // a lock. A session id must be one this connection opened (like every
  // command); none → the skills a session created now would have (a client
  // opens its session lazily, at the first prompt).
  private sessionSkills(params: SessionSkillsParams): Promise<SessionSkillsResult> {
    if (params.sessionId === undefined) {
      return this.host.newSessionSkills(params.settings);
    }
    return this.lookup(params.sessionId).skills();
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
    hosted.enqueue(params.id, params.turnId, params.text, params.voice);
    await hosted.persisted();
    return {};
  }

  // Synchronous like `enqueue` (one step, no lock); only the ACK waits — on
  // `serve`, until the reclaim is on disk (a reclaimed row never comes back
  // after a restart). Who reclaims is not checked: one token, one principal.
  // A session no longer live (closed, archived — its close handed the rows
  // back just before) needs no open: its record is rewritten, never reopened
  // (owner F2); a deleted id is `SessionDeleted`.
  private async reclaim(params: ReclaimParams): Promise<ReclaimResult> {
    if (this.host.get(params.sessionId) === undefined) {
      await this.host.reclaimArchived(params.sessionId, params.ids);
      return {};
    }
    const hosted = this.lookup(params.sessionId);
    hosted.reclaim(params.ids);
    await hosted.persisted();
    return {};
  }

  // Synchronous and lock-free (AGENTS §7): `HostedSession.clear` never awaits.
  private clear(params: ClearParams): ClearResult {
    return this.lookup(params.sessionId).clear();
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
    hosted.resolvePermission(params.requestId, params.optionId, params.message);
    return {};
  }

  /** `session/subagent_message`, in the shape `ResolvePermission` takes (a typed refusal, not a throw). */
  private messageSubagent(
    hosted: HostedSession,
    agentId: string,
    text: string,
  ): SubagentMessageResult {
    return hosted.messageSubagent(agentId, text);
  }

  /**
   * `device/pair` — the ONLY request a pairing connection may make (9c). It is
   * answered from the principal's own handler, so the key that gets registered
   * is the one THIS socket authenticated as, and the attempt cap is this
   * socket's. A token or `device` principal has nothing to pair: refused with
   * `already_paired` (a paired phone re-pairing is a new key or `revoke`).
   */
  private async devicePair(
    principal: ConnectionPrincipal,
    params: DevicePairParams,
    signal: AbortSignal | undefined,
  ): Promise<DevicePairResult> {
    if (principal.kind !== "pairing") {
      throw pairingRefusedError("already_paired");
    }
    const outcome = await principal.pair.pair(params, signal);
    if (!outcome.ok) {
      throw pairingRefusedError(outcome.reason);
    }
    return outcome.result;
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
    // D8/D9: this client can put a `move_session` proposal to its owner, so a
    // session IT creates may be offered the tool. Per connection (a pod daemon
    // serves a `run`, an `attach` and a hop target alike), and absent = no hop.
    this.hop = params.clientCapabilities.hop === true;
    // The label an `auto_accept` update carries: this connection's declared
    // device name (`clientInfo.host`, which only a TRUSTED daemon is ever given
    // one for), else its `clientInfo.name`. Picked ONCE, here, so a later frame
    // cannot claim another device's name.
    this.autoAcceptBy = params.clientInfo?.host ?? params.clientInfo?.name;
    this.clientHost = params.clientInfo?.host;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        tools: true,
        permissions: true,
        // What a client may send as an image (docs/feat/attachments-prompt.md
        // D2): absent when this daemon takes none, so an older daemon and a
        // model without vision read the same way.
        ...(this.host.images
          ? {
              images:
                this.host.images.source === "store"
                  ? { input: "upload", maxBytes: this.host.images.maxBytes }
                  : { input: "client" },
            }
          : {}),
      },
      ...(this.host.identity
        ? {
            agentInfo: {
              version: this.host.identity.tentacle,
              // The daemon's OWN model, for a client's display: a name and a
              // window, never an id or a key (AGENTS §7).
              ...(this.host.modelInfo
                ? {
                    model: this.host.modelInfo.name,
                    contextWindow: this.host.modelInfo.contextWindow,
                  }
                : {}),
            },
          }
        : {}),
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

  /**
   * `session/watch`: a read-only follower. A session must be LIVE (a `serve`
   * daemon's archived one is `UnknownSession`, never revived by a watch), and
   * this connection needs no `open` — a follower attaches nothing.
   */
  private watchSession(params: WatchParams): WatchResult {
    const hosted = this.host.get(params.sessionId);
    if (hosted === undefined) {
      throw new RpcError(
        DomainErrorCode.UnknownSession,
        `unknown or archived session: ${params.sessionId} (a watch never revives a session)`,
      );
    }
    const result = hosted.watch(params.only);
    this.dropStaleWatches();
    this.watches.set(result.watchId, { hosted, watchId: result.watchId });
    return result;
  }

  // Held until the watcher has something (or the hold times out): concurrent
  // with every other request here, never under a lock (AGENTS §7).
  private watchNext(params: WatchNextParams): Promise<WatchNextResult> {
    const watch = this.watches.get(params.watchId);
    if (watch === undefined) {
      throw new RpcError(
        DomainErrorCode.UnknownWatch,
        `unknown watch: ${params.watchId} (not on this connection)`,
      );
    }
    return watch.hosted.watchNext(params.watchId, params.timeoutMs);
  }

  // Idempotent: an id this connection does not hold is a no-op success.
  private unwatch(params: UnwatchParams): UnwatchResult {
    const watch = this.watches.get(params.watchId);
    if (watch !== undefined) {
      this.watches.delete(params.watchId);
      watch.hosted.unwatch(params.watchId);
    }
    return {};
  }

  /** Forget every watcher whose session is no longer the live one under its id (a close, then a recreate). */
  private dropStaleWatches(): void {
    for (const [watchId, watch] of this.watches) {
      // The map key is a WATCH id; the identity check is per SESSION id.
      if (this.host.get(watch.hosted.id) !== watch.hosted) {
        watch.hosted.unwatch(watchId);
        this.watches.delete(watchId);
      }
    }
  }

  /** The ids of the sessions this connection watches (a copy; read-only, for tests/diagnostics). */
  get watchedSessionIds(): readonly string[] {
    return [...new Set([...this.watches.values()].map((watch) => watch.hosted.id))];
  }

  /**
   * A session this connection may READ the committed log of: one it opened
   * (`lookup`), or one it only watches — the `logs --tail` cold read a follower
   * does, which must not force an `open` (an open would attach and count). The
   * identity check is `lookup`'s: a session closed and recreated under the same
   * id is not the one this connection reads.
   */
  private readable(sessionId: string): HostedSession {
    const entry = this.attached.get(sessionId);
    if (entry && this.host.get(sessionId) === entry.hosted) {
      return entry.hosted;
    }
    const watched = [...this.watches.values()].find((watch) => watch.hosted.id === sessionId);
    if (watched !== undefined && this.host.get(sessionId) === watched.hosted) {
      return watched.hosted;
    }
    this.dropStale();
    this.dropStaleWatches();
    throw new RpcError(
      DomainErrorCode.UnknownSession,
      `unknown session: ${sessionId} (not open or watched on this connection)`,
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
      ...(this.hop ? { hop: true } : {}),
      ...(this.servesModel ? { model: this } : {}),
      ...(this.clientHost !== undefined ? { host: this.clientHost } : {}),
      // The socket's own principal names the device (never a frame's claim): the
      // push rules exclude a device attached to this session — it is showing the
      // sheet already (docs/feat/mobile-push.md Design 1).
      ...(this.principal.kind === "device" ? { deviceId: this.principal.id } : {}),
    };
    const { hosted, created, resync, epoch } = this.host.open(params, attachment, prepared);
    this.attached.set(hosted.id, { hosted, attachment });
    return {
      sessionId: hosted.id,
      epoch,
      created,
      resync,
      ...(hosted.settingsReport ? { settings: hosted.settingsReport } : {}),
      // Present iff THIS daemon shares auto-accept (docs/feat/session-auto-accept.md
      // D2): a pod omits it, so no laptop client reads or sets it there.
      ...(this.host.sharedAutoAccept ? { autoAccept: hosted.autoAccept } : {}),
      // The switches' snapshot on every open/attach (F5), read in the same
      // synchronous segment as the attach: no update can fall between them.
      capabilities: hosted.capabilities(),
      // Read in this same synchronous segment as the replay: omitted when 0.
      ...(hosted.unflushedExits > 0 ? { unflushedExits: hosted.unflushedExits } : {}),
    };
  }

  /** The ids of the sessions this connection holds open (a copy; read-only, for tests/diagnostics). */
  get openSessionIds(): readonly string[] {
    return [...this.attached.keys()];
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
  // an unknown id is a no-op success. `ifLast` (a quit): with another client
  // still attached, only detach — the session (and its model link) stays theirs.
  // `closed`: did THIS request end a live session (a quit's delete hangs on it).
  private closeSession(params: CloseParams): CloseResult {
    if (params.ifLast === true) {
      const live = this.host.get(params.sessionId);
      const mine = this.attached.get(params.sessionId);
      const own = mine !== undefined && mine.hosted === live ? 1 : 0;
      if (live !== undefined && live.attachedCount > own) {
        this.detachSession(params);
        return { closed: false };
      }
    }
    this.attached.delete(params.sessionId);
    return { closed: this.host.close(params.sessionId) };
  }

  // This connection only stops listening: the session runs on for any client.
  // Synchronous, no lock (AGENTS §7). An id not open here is a no-op success;
  // a stale entry (closed and recreated meanwhile) is released the same way —
  // its attachment belongs to the old object, which is what we stop.
  private detachSession(params: DetachParams): DetachResult {
    const entry = this.attached.get(params.sessionId);
    if (entry) {
      this.release(entry);
      this.attached.delete(params.sessionId);
    }
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
    refuseWakeTurnId(params.turnId);
    const hosted = this.lookup(params.sessionId);
    // The PROMPTING connection is asked about project hooks: it is the client
    // with a human behind this turn (docs/feat/hooks-project-trust.md). The
    // laptop decides; a rejection (an old laptop's `MethodNotFound`, a drop)
    // is "declined" in the runner.
    return hosted.prompt(
      params.turnId,
      params.content,
      params.skill,
      this.askHooksTrust,
      params.voice,
    );
  }

  // Acks at once, like `prompt`: the cancel and the new turn happen daemon-side
  // in one step; the new turn is asked about hooks through THIS connection.
  private sendNow(params: SendNowParams): PromptResult {
    refuseWakeTurnId(params.turnId);
    const hosted = this.lookup(params.sessionId);
    return hosted.sendNow(params.turnId, params.interrupt, params.messages, this.askHooksTrust);
  }

  private readonly askHooksTrust: AskHooksTrust = (request, signal) => {
    // The host's own store first (a `serve` on the machine the folder lives on):
    // already trusted there = no prompt, and nothing to store from a remote. A
    // `declined` is that host's own "never" — a decision about the FOLDER, so a
    // remote does not get to re-ask it (S4 review 1, finding 2).
    const mine = this.hooksTrustPrecheck?.(request);
    if (mine === "trusted") {
      return Promise.resolve(true);
    }
    if (mine === "declined") {
      return Promise.resolve(false);
    }
    // Otherwise the PROMPTING client decides (it has the human behind this turn).
    return this.peer
      .request(Method.HooksTrust, request, signal ? { signal } : undefined)
      .then((result) => (result as HooksTrustResult).trusted === true);
  };

  private onNotification(method: string, params: unknown): void {
    if (method === Notification.Cancel) {
      const { sessionId, turnId } = params as CancelParams;
      const entry = this.attached.get(sessionId);
      if (entry && this.host.get(sessionId) === entry.hosted) {
        entry.hosted.cancel(turnId);
      }
    }
  }
}

/**
 * `wake-` is the daemon's own: a client that names one in `session/prompt` or
 * `session/send_now` is refused (docs/fix/autoaccept-wake-turns.md A2).
 *
 * This is SECURITY, not UX, on `serve` (AGENTS §7: the `serve` daemon is
 * trusted, and a TUI with auto-accept on answers a wake turn's asks as its own
 * session's). Without it, any other client of the same daemon could start a turn
 * whose id looks like a wake and ride that auto-accept for one `once` approval —
 * which is exactly the foreign-turn guard (docs/feat/tui-foreign-turns.md C5)
 * this prefix reservation exists to keep. `HostedSession.prompt` stays
 * unguarded: the daemon's own wake calls it directly.
 */
function refuseWakeTurnId(turnId: string): void {
  if (isWakeTurnId(turnId)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `turnId: the ${JSON.stringify(WAKE_TURN_PREFIX)} prefix is reserved for the daemon's own wake turns`,
    );
  }
}
