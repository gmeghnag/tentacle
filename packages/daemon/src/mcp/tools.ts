/**
 * The MCP session tools (docs/feat/serve-mcp-server.md, Design §3, §4, §8, §9;
 * slice M2): `session_start` · `send` · `status` · `cancel` · `list`.
 *
 * Every verb goes through A2A's protocol-neutral driver
 * (`external/session-driver.ts`): a real `Connection` over
 * `createChannelPair()` on the SAME `SessionHost` a phone drives — the single
 * session path (AGENTS §7). Reads are `HostedSession.workUnits()` (live) or the
 * archived read-only index (`external/archived-units.ts`): no MCP store.
 *
 * Untrusted caller (AGENTS §7): it works only in its own `mcp-<caller>-*`
 * namespace (`external/session-ids.ts`; any other id is "unknown session", the
 * same answer as a truly unknown one), changes no setting, and sees only each
 * turn's final round. Asks are the owner's unless `callerAsks` says `both` for
 * this caller (M3, Design §7): then `session_answer` may answer a `tool` ask of
 * a turn the caller started, once, through A2A's shared `external/asks.ts`.
 *
 * Tasks (M4, Design §3/§5/§6): for a request that declared the extension, a
 * call that starts a turn answers a `CreateTaskResult` (taskId = turnId) once
 * the turn's start is durable; `task` / `answerTask` / `cancelTask` back
 * `mcp/tasks.ts`. A task is the turn's unit projected, never stored.
 */
import type { WorkUnit } from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ErrorCode, RpcError, type RpcPeer } from "@tentacle/transport";
import type { HooksTrustPrecheck } from "../connection.ts";
import { ArchivedUnitIndex } from "../external/archived-units.ts";
import {
  type AskMode,
  type PendingAsk,
  askIsOwn,
  askOf,
  callerMayAnswer,
  callerOptions,
  resolveCallerAnswer,
} from "../external/asks.ts";
import { connectSession, detachSession, openSession } from "../external/session-driver.ts";
import { callerPrefix, contextIdOf, externalSessionId } from "../external/session-ids.ts";
import type { SessionHost } from "../session-host.ts";
import { decisionOf, projectTask } from "./task-projection.ts";
import { type CallToolResult, createTaskResult, toolError, toolResult } from "./wire.ts";

export const MCP_PROTOCOL = "mcp";
/** A prompt / steer, in UTF-8 bytes. */
export const MCP_TEXT_MAX_BYTES = 64 * 1024;
export const MCP_TITLE_MAX = 60;
export const MCP_KEY_MAX = 64;
export const MCP_WAIT_MAX_SECONDS = 120;
/** Live (loaded) `mcp-<caller>-*` sessions one caller may hold. */
export const MCP_MAX_LIVE_SESSIONS = 8;
export const MCP_LIST_MAX = 50;
/** The driver's attachment is released this long after its session's turn ended. */
export const MCP_DETACH_AFTER_MS = 60_000;
/** A refusal's reason as the caller may send it (cleaned and cut to the ask's own limit). */
export const MCP_ANSWER_MESSAGE_MAX = 4096;
const RECENT = 5;
/** One text for an ask the caller may not answer, whatever the reason (no oracle). */
export const NOT_ANSWERABLE =
  "not an approval you may answer: name a requestId from session_status asks";
const TURN_ID_MAX = 128;

export const UNKNOWN_SESSION = "unknown session";

/** Bad tool arguments: the HTTP layer answers JSON-RPC `-32602`, nothing is opened. */
export class InvalidToolParams extends Error {}

export interface McpToolsOptions {
  readonly host: SessionHost;
  /** The host's own project-hooks answer (the same one `serve` gives a socket). */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  /** `ClientInfo.version` (the build's version). */
  readonly version?: string;
  readonly onError?: (error: Error) => void;
  /** Overrides `MCP_DETACH_AFTER_MS` (tests). */
  readonly detachAfterMs?: number;
  /**
   * Who answers a caller's asks (`--mcp-asks`, Design §7): the owner only, or
   * the caller too. Absent, or `undefined` for a caller = `owner`.
   */
  readonly callerAsks?: (caller: string) => AskMode | undefined;
  /**
   * Make a started turn durable before its task is handed out (Design §3,
   * assumption 3; M4). Resolves whether the write landed. Absent: the
   * session's own `persisted()` (its latest write settled; no persister =
   * nothing to make durable).
   */
  readonly durable?: (sessionId: string, turnId: string) => Promise<boolean>;
}

/** A turn's start is awaited this long before its task is refused (a `session/prompt` already accepted it). */
export const MCP_TASK_START_MS = 10_000;
/** "could not record the task": the turn is cancelled, no task is handed out. */
export const TASK_NOT_RECORDED = "could not record the task";
/** Acceptance times kept for live tasks' `createdAt` (a live unit has no `startedAt`). */
const ACCEPTED_MAX = 256;

/** A tool call answered with a task (`CreateTaskResult`). */
export type TaskCreated = Record<string, unknown> & { readonly resultType: "task" };

/** A task as `tasks/get` reads it: the turn's unit and the asks THIS turn raised. */
export interface TaskLookup {
  readonly sessionId: string;
  readonly unit: WorkUnit;
  readonly asks: readonly PendingAsk[];
  readonly mode: AskMode;
  readonly acceptedAt?: number;
}

/** One live MCP session's in-process attachment (Design §9). */
interface Attachment {
  readonly sessionId: string;
  readonly peer: RpcPeer;
  /** Resolves once `initialize` + `session/open` answered. */
  ready: Promise<void>;
  /** Pending asks as the session sent them (titles for the status line). */
  readonly asks: Map<string, PendingAsk>;
  /** The turn each pending ask was raised by (a task answers only its own). */
  readonly askTurn: Map<string, string>;
  activeTurn?: string;
  /** Status waits parked on this session's next change. */
  readonly waiters: Set<() => void>;
  /** Waits for a turn's start (a task's `durable`), woken on `turn_start` / `turn_end`. */
  readonly starts: Set<() => void>;
  waiting: boolean;
  detachTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

/** The tools, as `tools/list` returns them (deterministic order). */
export const MCP_TOOLS: readonly Record<string, unknown>[] = [
  {
    name: "session_start",
    title: "Start a tentacle session",
    description:
      "Start a new tentacle session on this serve and run `prompt` as its first turn. Returns at once with {sessionId, turnId}; follow it with session_status.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "The task (≤ 64 KiB)." },
        title: { type: "string", maxLength: MCP_TITLE_MAX },
      },
      required: ["prompt"],
    },
    outputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, turnId: { type: "string" } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "session_send",
    title: "Send to a tentacle session",
    description:
      "Send `text` to one of your sessions: an idle session starts a new turn, a running turn is steered (`key` makes a retried steer a no-op).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        text: { type: "string", minLength: 1 },
        key: { type: "string", minLength: 1, maxLength: MCP_KEY_MAX },
      },
      required: ["sessionId", "text"],
    },
    outputSchema: {
      type: "object",
      properties: { turnId: { type: "string" }, steered: { type: "boolean" } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "session_status",
    title: "Status of a tentacle session",
    description:
      "The state of a turn (the latest unless `turnId`) and its final answer once it ended. `waitSeconds` (≤ 120) waits for the turn's next change.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        turnId: { type: "string" },
        waitSeconds: { type: "integer", minimum: 0, maximum: MCP_WAIT_MAX_SECONDS },
      },
      required: ["sessionId"],
    },
    outputSchema: { type: "object", properties: { state: { type: "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "session_answer",
    title: "Answer a tentacle tool approval",
    description:
      "Answer one approval listed in session_status `asks` (only when this serve lets callers answer): allow or deny it once. The owner is asked too; the first answer wins.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        requestId: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
        message: { type: "string", maxLength: MCP_ANSWER_MESSAGE_MAX },
      },
      required: ["sessionId", "requestId", "decision"],
    },
    outputSchema: { type: "object", properties: { answered: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "session_cancel",
    title: "Cancel a tentacle turn",
    description: "Cancel the running turn of one of your sessions (only `turnId` when given).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, turnId: { type: "string" } },
      required: ["sessionId"],
    },
    outputSchema: { type: "object", properties: { cancelled: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "session_list",
    title: "List your tentacle sessions",
    description: "The sessions you started on this serve, newest first (at most 50).",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { sessions: { type: "array" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// --- argument readers (throw InvalidToolParams) ------------------------------

function str(args: Record<string, unknown>, key: string, max?: number): string {
  const v = args[key];
  if (typeof v !== "string" || v === "" || (max !== undefined && v.length > max)) {
    throw new InvalidToolParams(`${key}: a non-empty string${max ? ` of at most ${max}` : ""}`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string, max: number): string | undefined {
  return args[key] === undefined ? undefined : str(args, key, max);
}

function text(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (new TextEncoder().encode(v).byteLength > MCP_TEXT_MAX_BYTES) {
    throw new InvalidToolParams(`${key}: at most ${MCP_TEXT_MAX_BYTES} bytes`);
  }
  return v;
}

function waitSeconds(args: Record<string, unknown>): number {
  const v = args.waitSeconds;
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MCP_WAIT_MAX_SECONDS) {
    throw new InvalidToolParams(`waitSeconds: an integer 0..${MCP_WAIT_MAX_SECONDS}`);
  }
  return v;
}

/** `MCP: <title, else the prompt's first line>`, at most 60 chars. */
export function mcpTitle(prompt: string, title?: string): string {
  const source = title ?? prompt;
  const first = (source.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  const room = MCP_TITLE_MAX - "MCP: ".length;
  const cut = first.length > room ? `${first.slice(0, room - 1)}…` : first;
  return cut === "" ? "MCP" : `MCP: ${cut}`;
}

const isLive = (u: WorkUnit) => u.state === "working" || u.state === "waiting";
const turnsOf = (units: readonly WorkUnit[]) => units.filter((u) => u.kind === "turn");

export class McpTools {
  private readonly opts: McpToolsOptions;
  private readonly attachments = new Map<string, Attachment>();
  private readonly archived: ArchivedUnitIndex;
  /** taskId → when its call was accepted (insertion order = age, bounded). */
  private readonly accepted = new Map<string, number>();

  constructor(opts: McpToolsOptions) {
    this.opts = opts;
    this.archived = new ArchivedUnitIndex(opts.host);
  }

  /** One `tools/call`. A domain refusal is an `isError` result; bad arguments throw `InvalidToolParams`. */
  async call(
    caller: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return (await this.dispatch(caller, name, args, false, signal)) as CallToolResult;
  }

  /**
   * One `tools/call` from a request that declared the tasks extension (M4): a
   * call that starts a turn answers a `CreateTaskResult` (taskId = turnId),
   * only once the turn's start is durable; anything else is `call`'s answer.
   */
  async callAsTask(
    caller: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult | TaskCreated> {
    return this.dispatch(caller, name, args, true, signal);
  }

  private async dispatch(
    caller: string,
    name: string,
    args: Record<string, unknown>,
    task: boolean,
    signal?: AbortSignal,
  ): Promise<CallToolResult | TaskCreated> {
    switch (name) {
      case "session_start":
        return this.start(caller, args, task);
      case "session_send":
        return this.send(caller, args, task);
      case "session_status":
        return this.status(caller, args, signal);
      case "session_answer":
        return this.answer(caller, args);
      case "session_cancel":
        return this.cancel(caller, args);
      case "session_list":
        return this.list(caller);
      default:
        throw new InvalidToolParams(`unknown tool: ${name}`);
    }
  }

  /** Sessions this process holds an attachment on (tests). */
  attachedSessionIds(): string[] {
    return [...this.attachments.keys()];
  }

  /** Release every attachment (the sessions live on). */
  dispose(): void {
    for (const a of [...this.attachments.values()]) this.release(a);
  }

  // --- verbs -------------------------------------------------------------------

  private async start(
    caller: string,
    args: Record<string, unknown>,
    task: boolean,
  ): Promise<CallToolResult | TaskCreated> {
    const prompt = text(args, "prompt");
    const title = optStr(args, "title", MCP_TITLE_MAX);
    if (this.liveCount(caller) >= MCP_MAX_LIVE_SESSIONS) {
      return toolError(
        `too many live sessions (${MCP_MAX_LIVE_SESSIONS}): cancel or wait for one to be archived`,
      );
    }
    const s = crypto.randomUUID();
    const sessionId = externalSessionId(MCP_PROTOCOL, caller, s);
    if (sessionId === null) {
      return toolError("no caller identity");
    }
    const turnId = `${s}.${crypto.randomUUID()}`;
    let a: Attachment;
    try {
      a = await this.attach(sessionId, mcpTitle(prompt, title));
      await this.prompt(a, turnId, prompt);
    } catch (error) {
      return toolError(`the session refused the prompt${codeOf(error)}`);
    }
    return task ? this.taskCreated(a, turnId) : toolResult({ sessionId, turnId });
  }

  private async send(
    caller: string,
    args: Record<string, unknown>,
    task: boolean,
  ): Promise<CallToolResult | TaskCreated> {
    const sessionId = str(args, "sessionId", 256);
    const body = text(args, "text");
    const key = optStr(args, "key", MCP_KEY_MAX);
    const s = this.own(caller, sessionId);
    if (s === null || !this.exists(sessionId)) {
      return toolError(UNKNOWN_SESSION);
    }
    try {
      const a = await this.attach(sessionId, "MCP");
      for (let attempt = 0; attempt < 2; attempt++) {
        const running = this.runningTurn(sessionId);
        if (running === undefined) {
          const turnId = `${s}.${crypto.randomUUID()}`;
          await this.prompt(a, turnId, body);
          // A steer adds no unit: only a new turn is a task.
          return task ? this.taskCreated(a, turnId) : toolResult({ turnId, steered: false });
        }
        try {
          await a.peer.request("session/enqueue", {
            sessionId,
            id: key ?? crypto.randomUUID(),
            turnId: running.id,
            text: body,
          });
          return toolResult({ turnId: running.id, steered: true });
        } catch (error) {
          // The turn ended between the read and the enqueue: once, as a new turn.
          if (!(error instanceof RpcError && error.code === ErrorCode.NoTurnRunning)) throw error;
        }
      }
      return toolError("the session is busy: try again");
    } catch (error) {
      return toolError(`the session refused the message${codeOf(error)}`);
    }
  }

  private async cancel(caller: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const sessionId = str(args, "sessionId", 256);
    const turnId = optStr(args, "turnId", TURN_ID_MAX);
    if (this.own(caller, sessionId) === null || !this.exists(sessionId)) {
      return toolError(UNKNOWN_SESSION);
    }
    const running = this.runningTurn(sessionId);
    if (running === undefined || (turnId !== undefined && turnId !== running.id)) {
      return toolResult({ sessionId, cancelled: false });
    }
    try {
      const a = await this.attach(sessionId, "MCP");
      // Per-turn cancel: a turn another device started meanwhile is never hit.
      a.peer.notify("session/cancel", { sessionId, turnId: running.id });
    } catch (error) {
      return toolError(`the session could not be reached${codeOf(error)}`);
    }
    return toolResult({ sessionId, turnId: running.id, cancelled: true });
  }

  /**
   * A caller's decision on one pending ask (Design §7). Only in `both` mode,
   * only an ask `callerMayAnswer` admits (a `tool` ask of a turn the caller
   * started), and only as that ask's own `*_once` option: the shared
   * `resolveCallerAnswer` picks it, the caller never names an option. The
   * owner was asked too; the first answer wins (a late one changes nothing).
   */
  private async answer(caller: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const sessionId = str(args, "sessionId", 256);
    const requestId = str(args, "requestId", 256);
    const decision = args.decision;
    if (decision !== "allow" && decision !== "deny") {
      throw new InvalidToolParams('decision: "allow" or "deny"');
    }
    const message = optStr(args, "message", MCP_ANSWER_MESSAGE_MAX);
    if (this.own(caller, sessionId) === null || !this.exists(sessionId)) {
      return toolError(UNKNOWN_SESSION);
    }
    const mode = this.modeOf(caller);
    if (mode !== "both") {
      return toolError("approvals are answered by the owner on this serve (--mcp-asks owner)");
    }
    if (this.opts.host.get(sessionId) === undefined) {
      return toolError(NOT_ANSWERABLE);
    }
    let a: Attachment;
    try {
      a = await this.attach(sessionId, "MCP");
    } catch (error) {
      return toolError(`the session could not be reached${codeOf(error)}`);
    }
    const resolved = resolveCallerAnswer(
      { requestId, decision, ...(message !== undefined ? { message } : {}) },
      [...a.asks.values()],
      mode,
    );
    if (resolved === null) {
      return toolError(NOT_ANSWERABLE);
    }
    try {
      await a.peer.request("session/resolve_permission", { sessionId, ...resolved });
    } catch (error) {
      // Answered meanwhile (first answer wins) or gone: nothing changed.
      return toolError(`the approval is no longer pending${codeOf(error)}`);
    }
    return toolResult({ sessionId, requestId, decision, answered: true });
  }

  // --- tasks (M4, Design §3, §5, §6) ------------------------------------------

  /**
   * The `CreateTaskResult` of a turn just accepted — returned ONLY once its
   * start is on disk (the spec's MUST): the turn is in `workUnits()` (its
   * start's write was scheduled in the same step), then `durable`. Either
   * failing → the turn is cancelled and the call answers `isError`: no
   * unrecorded task is ever handed out.
   */
  private async taskCreated(a: Attachment, turnId: string): Promise<CallToolResult | TaskCreated> {
    const acceptedAt = Date.now();
    this.accepted.set(turnId, acceptedAt);
    while (this.accepted.size > ACCEPTED_MAX) {
      const oldest = this.accepted.keys().next().value;
      if (oldest === undefined) break;
      this.accepted.delete(oldest);
    }
    const durable =
      this.opts.durable ??
      (async (id: string) => {
        await this.opts.host.get(id)?.persisted();
        return true;
      });
    const unit = (await this.started(a, turnId))
      ? await durable(a.sessionId, turnId).then(
          (landed) => (landed ? this.unitOf(a.sessionId, turnId) : undefined),
          () => undefined,
        )
      : undefined;
    if (unit === undefined) {
      if (!a.closed) a.peer.notify("session/cancel", { sessionId: a.sessionId, turnId });
      return toolError(TASK_NOT_RECORDED);
    }
    const view = projectTask({
      unit,
      asks: [],
      mode: "owner",
      elicitationForm: false,
      acceptedAt,
      now: Date.now(),
    });
    return createTaskResult(view) as TaskCreated;
  }

  /** Until the turn is in the session's units (started; it may have ended already), or a timeout. */
  private started(a: Attachment, turnId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const check = () => {
        const seen = this.unitOf(a.sessionId, turnId) !== undefined;
        if (!seen && !a.closed) return;
        a.starts.delete(check);
        clearTimeout(timer);
        resolve(seen);
      };
      const timer = setTimeout(() => {
        a.starts.delete(check);
        resolve(false);
      }, MCP_TASK_START_MS);
      a.starts.add(check);
      check();
    });
  }

  private unitOf(sessionId: string, turnId: string): WorkUnit | undefined {
    return turnsOf(this.opts.host.get(sessionId)?.workUnits() ?? []).find((u) => u.id === turnId);
  }

  /**
   * The caller's task `taskId` (= a turn id `<s>.<t>`), or undefined — the
   * same for a malformed id, another caller's session (it is resolved under
   * THIS caller's prefix only) or an evicted unit (no oracle). Live units come
   * from `workUnits()`, an archived session's from the read-only index (never
   * reopened). A live turn waiting on an ask re-attaches lazily (Design §9),
   * so the asks it raised are known.
   */
  async task(caller: string, taskId: string): Promise<TaskLookup | undefined> {
    const dot = taskId.indexOf(".");
    if (dot <= 0 || taskId.length > TURN_ID_MAX) return undefined;
    const sessionId = externalSessionId(MCP_PROTOCOL, caller, taskId.slice(0, dot));
    if (sessionId === null) return undefined;
    const read = await this.read(caller, sessionId);
    const unit = read === undefined ? undefined : turnsOf(read.units).find((u) => u.id === taskId);
    if (read === undefined || unit === undefined) return undefined;
    let a = this.attachments.get(sessionId);
    if (read.live && unit.state === "waiting" && (a === undefined || a.closed)) {
      a = await this.attach(sessionId, "MCP").catch(() => undefined);
    }
    const asks =
      a === undefined || !isLive(unit)
        ? []
        : [...a.asks.values()].filter((x) => a.askTurn.get(x.requestId) === taskId);
    const acceptedAt = this.accepted.get(taskId);
    return {
      sessionId,
      unit,
      asks,
      mode: this.modeOf(caller),
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    };
  }

  /**
   * `tasks/update`: each key naming a pending ask of THIS task that the caller
   * may answer is resolved with that ask's own `*_once` option (the shared
   * `resolveCallerAnswer`; `decline`/`cancel`/ambiguous → deny). A key naming
   * any other pending ask is refused (counted: the caller audits it), an
   * unknown key ignored (the spec). First answer wins: a late one is a no-op.
   */
  async answerTask(
    caller: string,
    taskId: string,
    responses: Record<string, unknown>,
  ): Promise<{ found: boolean; refused: number }> {
    const t = await this.task(caller, taskId);
    if (t === undefined) return { found: false, refused: 0 };
    const a = this.attachments.get(t.sessionId);
    let refused = 0;
    for (const [requestId, response] of Object.entries(responses)) {
      const pending = a?.asks.get(requestId);
      if (a === undefined || pending === undefined) continue;
      const mine = t.asks.includes(pending);
      const resolved = mine
        ? resolveCallerAnswer({ requestId, decision: decisionOf(response) }, [pending], t.mode)
        : null;
      if (resolved === null) {
        refused++;
        continue;
      }
      try {
        await a.peer.request("session/resolve_permission", {
          sessionId: t.sessionId,
          ...resolved,
        });
      } catch {
        // Answered meanwhile (first answer wins) or gone: nothing changed.
      }
    }
    return { found: true, refused };
  }

  /** `tasks/cancel`: a live task's turn gets the one per-turn `session/cancel`; an ended one is untouched. */
  async cancelTask(caller: string, taskId: string): Promise<boolean> {
    const t = await this.task(caller, taskId);
    if (t === undefined) return false;
    if (isLive(t.unit)) {
      const a = await this.attach(t.sessionId, "MCP").catch(() => undefined);
      a?.peer.notify("session/cancel", { sessionId: t.sessionId, turnId: taskId });
    }
    return true;
  }

  private modeOf(caller: string): AskMode {
    return this.opts.callerAsks?.(caller) ?? "owner";
  }

  private list(caller: string): CallToolResult {
    const prefix = callerPrefix(MCP_PROTOCOL, caller);
    const sessions: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    while (prefix !== null && sessions.length < MCP_LIST_MAX) {
      const page = this.opts.host.list(cursor === undefined ? {} : { cursor });
      for (const e of page.sessions) {
        if (!e.sessionId.startsWith(prefix) || sessions.length >= MCP_LIST_MAX) continue;
        sessions.push({
          sessionId: e.sessionId,
          title: e.title,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          running: e.running,
          archived: e.archived,
        });
      }
      if (page.cursor === undefined) break;
      cursor = page.cursor;
    }
    return toolResult({ sessions });
  }

  private async status(
    caller: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const sessionId = str(args, "sessionId", 256);
    const turnId = optStr(args, "turnId", TURN_ID_MAX);
    const wait = waitSeconds(args);
    if (this.own(caller, sessionId) === null) {
      return toolError(UNKNOWN_SESSION);
    }
    let read = await this.read(caller, sessionId);
    if (read === undefined) {
      return toolError(UNKNOWN_SESSION);
    }
    let unit = pick(read.units, turnId);
    if (unit === null) {
      return toolError("unknown turn");
    }
    if (wait > 0 && read.live && unit !== undefined && isLive(unit)) {
      const a = await this.attach(sessionId, "MCP").catch(() => undefined);
      if (a !== undefined) {
        if (a.waiting) {
          return toolError("a status wait is already running on this session");
        }
        a.waiting = true;
        try {
          await this.nextChange(a, unit, turnId, wait * 1000, signal);
        } finally {
          a.waiting = false;
        }
        read = (await this.read(caller, sessionId)) ?? read;
        unit = pick(read.units, turnId) ?? unit;
      }
    }
    return toolResult(this.project(sessionId, read.units, unit, this.modeOf(caller)));
  }

  // --- reads ---------------------------------------------------------------------

  /** The contextId of the caller's OWN session id; null for anyone else's (phone, A2A, another caller). */
  private own(caller: string, sessionId: string): string | null {
    return contextIdOf(MCP_PROTOCOL, caller, sessionId);
  }

  private exists(sessionId: string): boolean {
    return (
      this.opts.host.get(sessionId) !== undefined ||
      this.opts.host.archivedSessions().some((r) => r.id === sessionId)
    );
  }

  private liveCount(caller: string): number {
    let n = 0;
    for (const s of this.opts.host.values()) {
      if (this.own(caller, s.id) !== null) n++;
    }
    return n;
  }

  private runningTurn(sessionId: string): WorkUnit | undefined {
    return turnsOf(this.opts.host.get(sessionId)?.workUnits() ?? []).find(isLive);
  }

  /** The session's units: live (`workUnits()`), else archived (read-only, never reopened). */
  private async read(
    caller: string,
    sessionId: string,
  ): Promise<{ live: boolean; units: WorkUnit[] } | undefined> {
    const live = this.opts.host.get(sessionId);
    if (live !== undefined) {
      return { live: true, units: live.workUnits() };
    }
    const contextId = this.own(caller, sessionId);
    if (contextId === null || !this.opts.host.archivedSessions().some((r) => r.id === sessionId)) {
      return undefined;
    }
    const units = await this.archived.units(MCP_PROTOCOL, caller, { contextId, results: true });
    return { live: false, units: units.map((u) => u.unit) };
  }

  private project(
    sessionId: string,
    units: readonly WorkUnit[],
    unit: WorkUnit | undefined,
    mode: AskMode,
  ): Record<string, unknown> {
    const recent = turnsOf(units)
      .filter((u) => !isLive(u))
      .slice(-RECENT)
      .reverse()
      .map((u) => ({
        turnId: u.id,
        state: u.state,
        ...(u.reason !== undefined ? { reason: u.reason } : {}),
      }));
    if (unit === undefined) {
      return { sessionId, state: "idle", recent };
    }
    const asks = [...(this.attachments.get(sessionId)?.asks.values() ?? [])];
    // Only what the caller may answer, only in `both` (the shared rule, never a copy).
    const answerable =
      unit.state === "waiting" && unit.waitingFor === "permission"
        ? asks.filter((a) => callerMayAnswer(a, mode))
        : [];
    const statusMessage =
      answerable.length > 0
        ? `approval needed: ${answerable.map((a) => `${a.title} — session_answer requestId=${a.requestId}`).join("; ")}`
        : unit.state === "waiting" && unit.waitingFor === "permission"
          ? `waiting for the owner's approval${asks.length > 0 ? `: ${asks.map((a) => a.title).join("; ")}` : ""}`
          : unit.state === "waiting"
            ? "waiting for the owner"
            : unit.reason;
    return {
      sessionId,
      turnId: unit.id,
      state: unit.state,
      ...(unit.waitingFor !== undefined ? { waitingFor: unit.waitingFor } : {}),
      ...(statusMessage !== undefined ? { statusMessage } : {}),
      ...(answerable.length > 0
        ? {
            asks: answerable.map((a) => ({
              requestId: a.requestId,
              title: a.title,
              options: callerOptions(a).map((o) => (o.kind === "allow_once" ? "allow" : "deny")),
            })),
          }
        : {}),
      // The final round only (never tool output or the transcript: §8).
      ...(unit.result !== undefined && !isLive(unit) ? { result: unit.result } : {}),
      ...(unit.resultDropped === true ? { resultDropped: true } : {}),
      recent,
    };
  }

  // --- the driver's attachment (Design §9) -----------------------------------

  /** The session's one in-process attachment: reused, else opened (`create` + `reopen`). */
  private async attach(sessionId: string, title: string): Promise<Attachment> {
    const held = this.attachments.get(sessionId);
    if (held !== undefined && !held.closed) {
      await held.ready;
      return held;
    }
    const a: Attachment = {
      sessionId,
      asks: new Map(),
      askTurn: new Map(),
      waiters: new Set(),
      starts: new Set(),
      waiting: false,
      closed: false,
      ready: Promise.resolve(),
      peer: connectSession(this.opts, {
        onUpdate: (params) => this.onUpdate(a, params),
        onClose: () => this.dropped(a),
      }),
    };
    this.attachments.set(sessionId, a);
    a.ready = openSession(a.peer, {
      sessionId,
      title,
      client: { name: MCP_PROTOCOL, version: this.opts.version ?? "0" },
    });
    try {
      await a.ready;
    } catch (error) {
      this.release(a);
      throw error;
    }
    this.settle(a);
    return a;
  }

  private async prompt(a: Attachment, turnId: string, body: string): Promise<void> {
    if (a.detachTimer !== undefined) {
      clearTimeout(a.detachTimer);
      a.detachTimer = undefined;
    }
    try {
      await a.peer.request("session/prompt", {
        sessionId: a.sessionId,
        turnId,
        content: [{ type: "text", text: body }],
      });
    } finally {
      this.settle(a);
    }
  }

  private onUpdate(a: Attachment, params: KnownSessionUpdateParams): void {
    if (a.closed || params.sessionId !== a.sessionId) return;
    const u = params.update;
    switch (u.type) {
      case "turn_start":
        a.activeTurn = u.turnId;
        this.settle(a);
        this.wakeStarts(a);
        return;
      case "permission_request": {
        // The caller's own only when raised by a turn IT started (`<ctx>.<t>`,
        // Design §3): an ask of the owner's turn in this session stays the owner's.
        const turn = a.activeTurn ?? this.runningTurn(a.sessionId)?.id;
        const own = turn !== undefined && isCallerTurn(a.sessionId, turn) && askIsOwn(u, turn);
        a.asks.set(u.requestId, askOf(u, own));
        if (turn !== undefined) a.askTurn.set(u.requestId, turn);
        this.wake(a);
        return;
      }
      case "permission_resolved":
        a.askTurn.delete(u.requestId);
        if (a.asks.delete(u.requestId)) this.wake(a);
        return;
      case "turn_end":
        this.settle(a);
        this.wake(a);
        this.wakeStarts(a);
        return;
      default:
        return;
    }
  }

  /** Held while a turn runs; released `detachAfterMs` after none does. */
  private settle(a: Attachment): void {
    if (a.closed) return;
    if (this.runningTurn(a.sessionId) !== undefined) {
      if (a.detachTimer !== undefined) {
        clearTimeout(a.detachTimer);
        a.detachTimer = undefined;
      }
      return;
    }
    if (a.detachTimer === undefined) {
      a.detachTimer = setTimeout(
        () => this.release(a),
        this.opts.detachAfterMs ?? MCP_DETACH_AFTER_MS,
      );
    }
  }

  private wake(a: Attachment): void {
    for (const w of [...a.waiters]) w();
  }

  private wakeStarts(a: Attachment): void {
    for (const w of [...a.starts]) w();
  }

  /**
   * Until the unit changes (a turn end, an ask raised or resolved), `ms`
   * passes, or the caller goes away. The waiter is parked BEFORE the re-read,
   * so a change between the first read and the park is never missed.
   */
  private nextChange(
    a: Attachment,
    seen: WorkUnit,
    turnId: string | undefined,
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        a.waiters.delete(done);
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      a.waiters.add(done);
      signal?.addEventListener("abort", done);
      const now = pick(this.opts.host.get(a.sessionId)?.workUnits() ?? [], turnId);
      if (
        signal?.aborted === true ||
        a.closed ||
        now === null ||
        now === undefined ||
        now.id !== seen.id ||
        now.state !== seen.state ||
        now.waitingFor !== seen.waitingFor
      ) {
        done();
      }
    });
  }

  private release(a: Attachment): void {
    if (a.closed) return;
    this.dropped(a);
    detachSession(a.peer, a.sessionId);
  }

  private dropped(a: Attachment): void {
    a.closed = true;
    if (a.detachTimer !== undefined) clearTimeout(a.detachTimer);
    if (this.attachments.get(a.sessionId) === a) this.attachments.delete(a.sessionId);
    this.wake(a);
    this.wakeStarts(a);
  }
}

/** `turnId` named → that turn (null: no such turn); else the newest turn (undefined: none yet). */
function pick(units: readonly WorkUnit[], turnId: string | undefined): WorkUnit | null | undefined {
  const turns = turnsOf(units);
  if (turnId === undefined) return turns.at(-1);
  return turns.find((u) => u.id === turnId) ?? null;
}

/**
 * Did the MCP caller start this turn? Its turn ids are `<ctx>.<uuid>` with
 * `<ctx>` the session's own context (`mcp-<caller>-<ctx>`; the caller and the
 * protocol word hold no `-`).
 */
function isCallerTurn(sessionId: string, turnId: string): boolean {
  const cut = sessionId.indexOf("-", MCP_PROTOCOL.length + 1);
  const ctx = cut < 0 ? "" : sessionId.slice(cut + 1);
  return ctx !== "" && turnId.startsWith(`${ctx}.`);
}

function codeOf(error: unknown): string {
  return error instanceof RpcError ? ` (${error.code})` : "";
}
