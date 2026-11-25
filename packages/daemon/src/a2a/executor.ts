/**
 * The A2A `AgentExecutor` (docs/feat/a2a.md, Design "Executor"; slice S4).
 *
 * An A2A task is a TURN on the single session path (AGENTS §7): each new task
 * builds a real `Connection` over `createChannelPair()` — the object a socket
 * becomes in `ws-server.ts` — and speaks the existing protocol as a client:
 * `initialize` → `session/open{create, reopen}` on `a2a-<caller>-<contextId>`
 * → `session/prompt{turnId: taskId}`. No agent loop, no session code, no
 * store: the turn's state is the session's, and its end is read back from
 * `HostedSession.workUnits()` (the same record `GetTask` projects).
 *
 * Asks (S5): per caller, `owner` (default — the owner's devices answer, the
 * task reads WORKING + "waiting for the owner's approval") or `both` (a
 * caller-answerable ask also reads INPUT_REQUIRED, and the caller's follow-up
 * answers it with the ask's `*_once` option; `external/asks.ts`).
 *
 * What the adapter NEVER does (a remote is not trusted, AGENTS §7): answer an
 * ask on its own, answer an owner-only ask (a lasting kind, or one not
 * provably the task's), pick an `*_always` option, say `hooks/trust: true`,
 * or send any method beyond open / prompt / resolve_permission / cancel /
 * detach.
 *
 * The SDK turns an `execute` rejection into a FAILED task on the task's bus,
 * so every refusal here is PUBLISHED (`REJECTED` + a reason), never thrown.
 */
import {
  type AgentCard,
  type Message,
  type Part,
  Role,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { type WorkUnit, unifyTurn } from "@tentacle/core";
import {
  KNOWN_UPDATE_TYPES,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, type HooksTrustPrecheck } from "../connection.ts";
import {
  type AskMode,
  type PendingAsk,
  type ResolvedAnswer,
  askIsOwn,
  askOf,
  callerMayAnswer,
  resolveCallerAnswer,
} from "../external/asks.ts";
import type { SessionHost } from "../session-host.ts";
import {
  type ProjectedStatus,
  a2aSessionId,
  a2aTitle,
  chunkAppend,
  inboundParts,
  parseTextAnswer,
  projectStatus,
  responseText,
} from "./mapping.ts";

/** The one artifact a turn task streams: the final round's text. */
export const RESPONSE_ARTIFACT_ID = "response";

export const REFUSED = {
  unauthenticated: "no caller identity",
  badIds: "the contextId is not a safe word ([A-Za-z0-9_.:-], at most 128 chars)",
  unsupportedPart: "raw and url parts are not accepted",
  invalidData: "a tentacle/* data part is malformed",
  empty: "the message has no text",
  workflow: "workflow tasks are not enabled for this caller",
  answer: "there is no task to answer: send the answer with the task's taskId",
  busy: "the context is busy: a task is already running in it",
  running: "the task is running and takes no input now: it waits on no ask you may answer",
  notAnswerable:
    "not an answer to an ask you may answer: name a requestId from the task's status, or send the text allow with one ask pending",
} as const;

/** What one caller (= one A2A token) may do. */
export interface CallerPolicy {
  /** Who answers its tasks' asks: the owner only (default), or the caller too. */
  readonly asks: AskMode;
}

export interface A2AExecutorOptions {
  readonly host: SessionHost;
  /** Per caller; absent (or no policy) = `{asks: "owner"}`. */
  readonly callerPolicy?: (caller: string) => CallerPolicy | undefined;
  /** The host's own project-hooks answer (the same one `serve` gives a socket). */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  /** `ClientInfo.version` (the build's version). */
  readonly version?: string;
  /** Non-fatal errors of the in-process connection. */
  readonly onError?: (error: Error) => void;
}

/** One running turn task: its connection and what has been published. */
interface Watcher {
  readonly taskId: string;
  readonly contextId: string;
  readonly sessionId: string;
  /** The caller that started it: the only one whose answer is admitted. */
  readonly caller: string;
  readonly mode: AskMode;
  readonly peer: RpcPeer;
  readonly bus: ExecutionEventBus;
  readonly asks: Map<string, PendingAsk>;
  /**
   * A caller's answer admitted in INPUT_REQUIRED (`admitFollowUp`), not yet
   * taken by its `execute`: while set, a second answer is refused, so two
   * follow-ups never publish on the shared bus at once.
   */
  claim?: { readonly answer: ResolvedAnswer; consumed: boolean };
  inTurn: boolean;
  afterTool: boolean;
  hasChunks: boolean;
  last: ProjectedStatus;
  ended: boolean;
  readonly done: Promise<void>;
  finish(): void;
}

/** The `daemon → client` requests the adapter answers: `hooks/trust` is always NO. */
export function adapterRequest(method: string): unknown {
  if (method === "hooks/trust") {
    // An untrusted remote never creates a lasting approval (AGENTS §7).
    return { trusted: false };
  }
  throw new RpcError(ErrorCode.MethodNotFound, `a2a adapter: ${method} not supported`);
}

function textPart(value: string): Part {
  return { content: { $case: "text", value }, mediaType: "text/plain", filename: "", metadata: {} };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function status(taskId: string, contextId: string, s: ProjectedStatus): Task["status"] {
  return {
    state: s.state,
    message: s.message === undefined ? undefined : agentMessage(taskId, contextId, s.message),
    timestamp: new Date().toISOString(),
  };
}

export class A2AExecutor implements AgentExecutor {
  private readonly opts: A2AExecutorOptions;
  /** Live turn tasks by taskId (in memory only; the session log is the record). */
  private readonly watchers = new Map<string, Watcher>();

  constructor(opts: A2AExecutorOptions) {
    this.opts = opts;
  }

  /** The tasks this executor is driving now (tests, and S5/S6's routing). */
  liveTaskIds(): string[] {
    return [...this.watchers.keys()];
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    if (ctx.task !== undefined) {
      return this.followUp(ctx, bus);
    }
    const reject = (reason: string) => this.publishRefused(ctx, bus, reason);
    const user = ctx.context.user;
    if (user === undefined || !user.isAuthenticated) {
      return reject(REFUSED.unauthenticated);
    }
    const sessionId = a2aSessionId(user.userName, contextId);
    if (sessionId === null) {
      return reject(REFUSED.badIds);
    }
    const parts = inboundParts(ctx.userMessage.parts);
    if (!parts.ok) {
      return reject(
        parts.reason === "unsupported_part"
          ? REFUSED.unsupportedPart
          : parts.reason === "invalid_data"
            ? REFUSED.invalidData
            : REFUSED.empty,
      );
    }
    if (parts.workflow !== undefined) {
      return reject(REFUSED.workflow);
    }
    if (parts.answer !== undefined) {
      return reject(REFUSED.answer);
    }
    if (parts.text === "") {
      return reject(REFUSED.empty);
    }

    const mode = this.opts.callerPolicy?.(user.userName)?.asks ?? "owner";
    const watcher = this.connect(
      { taskId, contextId, sessionId, caller: user.userName, mode },
      bus,
    );
    try {
      await watcher.peer.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // Every known update, so `permission_request` (blocking) is DECLARED:
        // an attachment that did not declare it would make the host deny
        // every ask at once (hosted-session's ask gate).
        clientCapabilities: { streaming: true, updates: [...KNOWN_UPDATE_TYPES] },
        // No `host`: the owner's ask is never "also asked on A2A".
        clientInfo: { name: "a2a", version: this.opts.version ?? "0" },
      });
      await watcher.peer.request("session/open", {
        sessionId,
        create: true,
        reopen: true,
        title: { text: a2aTitle(parts.text), source: "user" },
      });
    } catch (error) {
      this.teardown(watcher);
      return this.publishFirst(ctx, bus, {
        state: TaskState.TASK_STATE_FAILED,
        message: `the session could not be opened${codeOf(error)}`,
      });
    }

    this.publishFirst(ctx, bus, { state: TaskState.TASK_STATE_WORKING });
    try {
      await watcher.peer.request("session/prompt", {
        sessionId,
        turnId: taskId,
        content: [{ type: "text", text: parts.text }],
      });
    } catch (error) {
      const busy = error instanceof RpcError && error.code === ErrorCode.TurnInProgress;
      this.end(watcher, {
        state: busy ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_FAILED,
        message: busy ? REFUSED.busy : `the session refused the prompt${codeOf(error)}`,
      });
    }
    await watcher.done;
  }

  async cancelTask(taskId: string, _bus: ExecutionEventBus): Promise<void> {
    const watcher = this.watchers.get(taskId);
    if (watcher === undefined || watcher.ended) {
      throw new TaskNotCancelableError(`task ${taskId} is not running here`);
    }
    // Per-turn cancel: a turn another device started meanwhile is never hit.
    // CANCELED comes from the turn's own end (the owner's stop is the same path).
    watcher.peer.notify("session/cancel", { sessionId: watcher.sessionId, turnId: taskId });
  }

  // --- follow-up ------------------------------------------------------------

  /**
   * Checked by `A2ARequestHandler` BEFORE the SDK runs `execute`, for a
   * message naming a task this executor is RUNNING. The task's bus is shared:
   * while its stream is live, any first event a second `execute` published
   * there (`task` / `message`) would break it (the SDK's ordering rule), so
   * such a message is refused (−32004) — except in INPUT_REQUIRED, where the
   * running stream has ended: then the message must be a valid answer to a
   * caller-answerable ask of the task (else −32602, the ask untouched), and it
   * is admitted as this task's one pending claim. Returns the claim's release,
   * for a request that fails before its `execute` takes it.
   */
  admitFollowUp(message: Message | undefined, context: ServerCallContext): () => void {
    const none = () => {};
    const taskId = message?.taskId;
    if (message === undefined || taskId === undefined || taskId === "") {
      return none;
    }
    const w = this.watchers.get(taskId);
    if (w === undefined || w.ended) {
      return none;
    }
    const user = context.user;
    if (user === undefined || !user.isAuthenticated || user.userName !== w.caller) {
      // Another caller's task does not exist for this one.
      throw new TaskNotFoundError(`Task not found: ${taskId}`);
    }
    if (w.last.state !== TaskState.TASK_STATE_INPUT_REQUIRED || w.claim !== undefined) {
      throw new UnsupportedOperationError(REFUSED.running);
    }
    const parts = inboundParts(message.parts);
    const pending = [...w.asks.values()];
    const answer =
      !parts.ok || parts.workflow !== undefined
        ? null
        : (parts.answer ??
          parseTextAnswer(
            parts.text,
            pending.filter((a) => callerMayAnswer(a, w.mode)),
          ));
    const resolved = answer === null ? null : resolveCallerAnswer(answer, pending, w.mode);
    if (resolved === null) {
      throw new RequestMalformedError(REFUSED.notAnswerable);
    }
    const claim = { answer: resolved, consumed: false };
    w.claim = claim;
    return () => {
      if (w.claim === claim && !claim.consumed) {
        w.claim = undefined;
      }
    };
  }

  /**
   * A follow-up that reached `execute`. Running here with an admitted answer:
   * take it, start the follow-up's stream with the task (WORKING), send the
   * answer, then follow the task to its next stop. Running without one (a
   * race past the guard): publish NOTHING, follow the task to its end so the
   * bus is not settled under it. Not running here (its watcher ended, or it
   * never had one): the stored snapshot, nothing sent.
   */
  private async followUp(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const watcher = this.watchers.get(ctx.taskId);
    if (watcher !== undefined && !watcher.ended) {
      const claim = watcher.claim;
      if (claim !== undefined && !claim.consumed && ctx.task !== undefined) {
        claim.consumed = true;
        watcher.claim = undefined;
        await this.answer(watcher, ctx.task, bus, claim.answer);
      }
      await watcher.done;
      return;
    }
    if (ctx.task !== undefined) {
      bus.publish(AgentEvent.task(ctx.task));
    }
  }

  /**
   * Send a caller's admitted answer: the ask's own `*_once` option, never an
   * `*_always` (`resolveCallerAnswer`). The owner was raised the same ask; the
   * first answer wins — a `PermissionNotPending` (or any refusal) changes
   * nothing, and the task re-reads what the session still holds.
   */
  private async answer(w: Watcher, task: Task, bus: ExecutionEventBus, a: ResolvedAnswer) {
    // The original stream ended at INPUT_REQUIRED; the follow-up's starts with the task.
    w.last = { state: TaskState.TASK_STATE_WORKING };
    bus.publish(AgentEvent.task({ ...task, status: status(w.taskId, w.contextId, w.last) }));
    try {
      await w.peer.request("session/resolve_permission", { sessionId: w.sessionId, ...a });
    } catch {
      this.publishStatus(w);
    }
  }

  // --- the in-process client ------------------------------------------------

  private connect(
    ids: {
      readonly taskId: string;
      readonly contextId: string;
      readonly sessionId: string;
      readonly caller: string;
      readonly mode: AskMode;
    },
    bus: ExecutionEventBus,
  ): Watcher {
    const { taskId } = ids;
    const [daemonEnd, clientEnd] = createChannelPair();
    // The SAME object a socket becomes (ws-server.ts): one session path.
    new Connection(daemonEnd, this.opts.host, this.opts.onError, {
      ...(this.opts.hooksTrustPrecheck !== undefined
        ? { hooksTrustPrecheck: this.opts.hooksTrustPrecheck }
        : {}),
    });
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const watcher: Watcher = {
      ...ids,
      bus,
      asks: new Map(),
      inTurn: false,
      afterTool: false,
      hasChunks: false,
      last: { state: TaskState.TASK_STATE_WORKING },
      ended: false,
      done,
      finish: () => finish(),
      peer: new RpcPeer(clientEnd, {
        onRequest: (method) => adapterRequest(method),
        onNotification: (method, params) => {
          if (method === "session/update") {
            this.onUpdate(watcher, params as KnownSessionUpdateParams);
          }
        },
        // The daemon went away under us: say nothing terminal (the turn may
        // still run daemon-side; GetTask reads its real state), just stop.
        onClose: () => {
          if (!watcher.ended) {
            this.teardown(watcher);
          }
        },
        ...(this.opts.onError !== undefined ? { onError: this.opts.onError } : {}),
      }),
    };
    this.watchers.set(taskId, watcher);
    return watcher;
  }

  private onUpdate(w: Watcher, params: KnownSessionUpdateParams): void {
    if (w.ended || params.sessionId !== w.sessionId) {
      return;
    }
    const u = params.update;
    switch (u.type) {
      case "turn_start":
        if (u.turnId === w.taskId) {
          w.inTurn = true;
        }
        return;
      case "tool_call":
        if (w.inTurn) {
          w.afterTool = true;
        }
        return;
      case "agent_message_chunk":
        if (w.inTurn && u.content.type === "text" && u.content.text !== "") {
          this.publishChunk(w, u.content.text);
        }
        return;
      case "permission_request":
        if (w.inTurn && (u.turnId === undefined || u.turnId === w.taskId)) {
          w.asks.set(u.requestId, askOf(u, askIsOwn(u, w.taskId)));
          this.publishStatus(w);
        }
        return;
      case "permission_resolved":
        if (w.asks.delete(u.requestId)) {
          this.publishStatus(w);
        }
        return;
      case "turn_end":
        if (u.turnId === w.taskId) {
          this.endFromUnit(w, u.stopReason);
        }
        return;
      default:
        return;
    }
  }

  private publishChunk(w: Watcher, text: string): void {
    const append = chunkAppend(w.afterTool, w.hasChunks);
    w.afterTool = false;
    w.hasChunks = true;
    w.bus.publish(
      AgentEvent.artifactUpdate({
        taskId: w.taskId,
        contextId: w.contextId,
        artifact: artifact([textPart(text)]),
        append,
        lastChunk: false,
        metadata: {},
      }),
    );
  }

  /**
   * The running turn's status in the caller's mode: an owner-only ask reads
   * WORKING + "waiting for the owner"; in `both`, a caller-answerable one
   * reads INPUT_REQUIRED + the ask (which ends the live stream: the SDK's rule).
   */
  private publishStatus(w: Watcher): void {
    const asks = [...w.asks.values()];
    const unit = unifyTurn({ turnId: w.taskId, asking: asks.length > 0 });
    const next = projectStatus(unit, w.mode, asks);
    if (next.state === w.last.state && next.message === w.last.message) {
      return;
    }
    w.last = next;
    w.bus.publish(
      AgentEvent.statusUpdate({
        taskId: w.taskId,
        contextId: w.contextId,
        status: status(w.taskId, w.contextId, next),
        metadata: {},
      }),
    );
  }

  /**
   * The turn ended: its record is the session's own unit (`workUnits()`, the
   * one `GetTask` projects), so the live end and a later read agree. A turn
   * with no unit (cancelled before it started) falls back to `unifyTurn`.
   */
  private endFromUnit(w: Watcher, stopReason: string): void {
    const unit: WorkUnit =
      this.opts.host
        .get(w.sessionId)
        ?.workUnits()
        .find((x) => x.kind === "turn" && x.id === w.taskId) ??
      unifyTurn({ turnId: w.taskId, stopReason });
    const response = responseText(unit);
    if (response.text !== undefined || w.hasChunks) {
      // The final round, whole: replaces whatever the deltas built.
      w.bus.publish(
        AgentEvent.artifactUpdate({
          taskId: w.taskId,
          contextId: w.contextId,
          artifact: artifact(response.text === undefined ? [] : [textPart(response.text)]),
          append: false,
          lastChunk: true,
          metadata: {},
        }),
      );
    }
    const projected = projectStatus(unit, w.mode);
    const message = [projected.message, response.note].filter((m) => m !== undefined).join("\n");
    this.end(w, message === "" ? { state: projected.state } : { state: projected.state, message });
  }

  /** Publish the terminal status, then detach and close: the session lives on. */
  private end(w: Watcher, last: ProjectedStatus): void {
    if (w.ended) {
      return;
    }
    w.last = last;
    w.bus.publish(
      AgentEvent.statusUpdate({
        taskId: w.taskId,
        contextId: w.contextId,
        status: status(w.taskId, w.contextId, last),
        metadata: {},
      }),
    );
    // The SDK settles (closes) the bus once `execute` returns.
    this.teardown(w);
  }

  private teardown(w: Watcher): void {
    w.ended = true;
    this.watchers.delete(w.taskId);
    void w.peer
      .request("session/detach", { sessionId: w.sessionId })
      .catch(() => undefined)
      .finally(() => {
        w.peer.close();
      });
    w.finish();
  }

  // --- first events ---------------------------------------------------------

  /** Every `execute` must publish a Task first (the SDK rejects anything else). */
  private publishFirst(ctx: RequestContext, bus: ExecutionEventBus, s: ProjectedStatus): void {
    bus.publish(
      AgentEvent.task({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: status(ctx.taskId, ctx.contextId, s),
        artifacts: [],
        history: [ctx.userMessage],
        metadata: {},
      }),
    );
  }

  private publishRefused(ctx: RequestContext, bus: ExecutionEventBus, reason: string): void {
    this.publishFirst(ctx, bus, { state: TaskState.TASK_STATE_REJECTED, message: reason });
  }
}

/**
 * The SDK's request handler with the one check only the executor can make: a
 * message naming a task this executor is running is admitted (a valid answer
 * in INPUT_REQUIRED) or refused as a JSON-RPC error, before the SDK runs
 * `execute` on the task's shared bus (`A2AExecutor.admitFollowUp`). A request
 * that fails before its `execute` takes the admitted answer releases it.
 */
export class A2ARequestHandler extends DefaultRequestHandler {
  private readonly a2a: A2AExecutor;

  constructor(card: AgentCard, store: TaskStore, executor: A2AExecutor) {
    super(card, store, executor);
    this.a2a = executor;
  }

  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Message | Task> {
    const release = this.a2a.admitFollowUp(params.message, context);
    try {
      return await super.sendMessage(params, context);
    } catch (error) {
      release();
      throw error;
    }
  }

  override async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const release = this.a2a.admitFollowUp(params.message, context);
    try {
      yield* super.sendMessageStream(params, context);
    } catch (error) {
      release();
      throw error;
    }
  }
}

function artifact(parts: Part[]) {
  return {
    artifactId: RESPONSE_ARTIFACT_ID,
    name: "response",
    description: "",
    parts,
    metadata: {},
    extensions: [],
  };
}

/** ` (code N)` for an RPC refusal; never its message (it may carry internals). */
function codeOf(error: unknown): string {
  return error instanceof RpcError ? ` (code ${error.code})` : "";
}
