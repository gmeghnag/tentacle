/**
 * A single hosted conversation on the daemon: wraps the agent `Session`, drives
 * one turn at a time, streams `session/update` params through a sink, routes the
 * agent's permission requests to the connected client, and keeps a bounded
 * replay buffer of the current turn (seq-numbered) for reconnect.
 *
 * A turn lives in the stream, not in a request: `prompt` acks at once, the turn
 * is bracketed by `turn_start`/`turn_end` updates, and `prompt`/`enqueue` are
 * idempotent by their client-chosen keys (a retry never runs or injects twice).
 *
 * A turn and a compaction are mutually exclusive: both hold the one busy slot
 * (`controller`), and a request that finds it taken is REJECTED — never queued,
 * never locked (AGENTS §7: the peer dispatches requests concurrently).
 */
import type { Session } from "@tentacle/agent";
import type { ChatMessage, JobController, PermissionBroker } from "@tentacle/core";
import type {
  KnownSessionUpdateParams,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionUpdate,
  TurnEnd,
  TurnError,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  assertTextOnly,
  contentToText,
  eventToUpdate,
  stopReasonToProtocol,
  toUpdateParams,
} from "./mapping.ts";
import { outcomeToResponse, toRequestPermissionParams } from "./permission-map.ts";

/** Receives each streamed `session/update` (one per emitted update). */
export type UpdateSink = (params: KnownSessionUpdateParams) => void;
/** Asks the connected client to resolve a permission request. */
export type RemotePermission = (params: RequestPermissionParams) => Promise<PermissionOutcome>;

/** Max updates retained for turn-scoped replay on reconnect. */
const MAX_REPLAY = 1024;

/** How a failed turn's error leaves the daemon (see `redactTurnError`). */
export interface TurnErrorPolicy {
  /**
   * Put the real message of a non-`RpcError` turn failure in `turn_end.error`.
   * Only for a LOCAL, trusted client (the in-process worker): a provider error
   * can carry endpoint or key material. Default: "internal error".
   */
  readonly exposeTurnErrors?: boolean;
  /** Receives every turn failure, unredacted — never silent. */
  readonly onTurnError?: (error: Error) => void;
}

/** The wire form of a turn failure: same policy as the peer's handler errors. */
export function redactTurnError(error: unknown, expose: boolean): TurnError {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message };
  }
  if (expose) {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || "internal error" };
  }
  return { message: "internal error" };
}

export class HostedSession {
  readonly id: string;
  private readonly session: Session;
  /** The busy slot: the active turn's OR compaction's controller (`cancel` aborts it). */
  private controller: AbortController | null = null;
  /** Which operation holds the slot: true for a compaction. */
  private compacting = false;
  private activeTurnId: string | null = null;
  /** Every turn this session accepted, by client `turnId`, for its lifetime (retries). */
  private readonly turns = new Map<string, { end?: TurnEnd }>();
  /** Every accepted `enqueue` id, for its lifetime (retries). */
  private readonly enqueued = new Set<string>();
  private readonly errorPolicy: TurnErrorPolicy;
  private currentToolCallId = "";
  private seq = 0;
  private turnBuffer: KnownSessionUpdateParams[] = [];
  private sink: UpdateSink | null = null;
  private readonly jobs: JobController | undefined;

  constructor(
    id: string,
    session: Session,
    permissions: PermissionBroker,
    requestPermission: RemotePermission,
    jobs?: JobController,
    errorPolicy: TurnErrorPolicy = {},
  ) {
    this.id = id;
    this.session = session;
    this.jobs = jobs;
    this.errorPolicy = errorPolicy;
    // The agent's permission gate routes here; we forward to the client and map
    // its choice back to a local allow/deny + scope.
    permissions.setRequester(async (req) => {
      const params = toRequestPermissionParams(this.id, this.currentToolCallId || "pending", req);
      const outcome = await requestPermission(params);
      return outcomeToResponse(outcome);
    });
    // A background job can exit while the session is idle (between turns), so we
    // stream the exit the moment it happens — not only at the next turn, where
    // the agent injects a note for the model. The client renders it like a local
    // job-exit notice; the TUI dedupes by job id against that next-turn event.
    jobs?.onExit((job) => {
      this.emit({
        type: "background_exit",
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
      });
    });
  }

  /** A turn or a compaction is active. */
  get running(): boolean {
    return this.controller !== null;
  }

  /** Attach (or detach with `null`) the sink that receives streamed updates. */
  setSink(sink: UpdateSink | null): void {
    this.sink = sink;
  }

  /** Buffered updates of the current turn with `seq` strictly greater than `afterSeq`. */
  replayFrom(afterSeq: number): KnownSessionUpdateParams[] {
    return this.turnBuffer.filter((p) => p.seq > afterSeq);
  }

  private emit(update: SessionUpdate): void {
    const params = toUpdateParams(this.id, ++this.seq, update);
    this.turnBuffer.push(params);
    if (this.turnBuffer.length > MAX_REPLAY) {
      this.turnBuffer.shift();
    }
    this.sink?.(params);
  }

  /**
   * Accept a turn and ack at once; the turn itself runs in `drive` and ends
   * with a `turn_end` update. Synchronous up to the ack ON PURPOSE: two prompts
   * arriving together must see the first one's controller (an `await` before it
   * would admit both). A retried `turnId` returns the cached ack — with the
   * outcome if that turn already ended — and never runs a second turn.
   */
  prompt(turnId: string, content: Parameters<typeof contentToText>[0]): PromptResult {
    // The key first: a retry is answered even while a turn runs, or after it ended.
    const known = this.turns.get(turnId);
    if (known) {
      return known.end ? { turnId, ended: known.end } : { turnId };
    }
    // Before the busy check: a rejected prompt starts and records nothing.
    assertTextOnly(content);
    this.assertIdle();
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = turnId;
    this.turns.set(turnId, {});
    this.turnBuffer = [];
    const text = contentToText(content);
    try {
      this.emit({ type: "turn_start", turnId, prompt: text });
    } catch (error) {
      // The turn is accepted (state above): a throwing sink must not strand it
      // as "running" forever — run it anyway; it ends through `finishTurn`.
      this.reportTurnError(error);
    }
    void this.drive(turnId, text, controller);
    return { turnId };
  }

  /**
   * Refuse a new operation while the busy slot is held. Every taker of the slot
   * calls this and takes it in the same synchronous stretch, so two concurrent
   * requests can never both pass.
   */
  private assertIdle(): void {
    if (this.controller) {
      throw this.compacting
        ? new RpcError(DomainErrorCode.CompactInProgress, "a compaction is running")
        : new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    }
  }

  /**
   * Consume the agent's turn and stream it. Never rejects: every exit ends in
   * exactly one effective `finishTurn`, and every failure reaches `onTurnError`.
   *
   * INVARIANT (steering, see the comment at agent.ts's late-steer drain): from
   * the agent's last drain to `finishTurn` clearing the controller there is NO
   * `await` here — `finishTurn` runs synchronously inside the loop body on the
   * agent's `turn_end` event, BEFORE the `return` that resumes the generator.
   * Pinned by the daemon test "no macrotask fits between the last steering
   * drain and the turn's end"; a microtask-only `await` would not be caught by
   * it, so keep this loop free of any.
   */
  private async drive(turnId: string, text: string, controller: AbortController): Promise<void> {
    try {
      for await (const event of this.session.send(text, controller.signal)) {
        if (event.type === "turn_end") {
          this.finishTurn(turnId, { stopReason: stopReasonToProtocol(event.reason) });
          return;
        }
        if (event.type === "tool_start") {
          this.currentToolCallId = event.id;
        }
        const update = eventToUpdate(event);
        if (update) {
          this.emit(update);
        }
      }
      // The generator ended without a `turn_end` (not an agent path today).
      this.finishTurn(turnId, { stopReason: "end_turn" });
    } catch (error) {
      // The agent (model/tool) failed — or the sink threw. Either way: report
      // it unredacted, then end the turn. `finishTurn` is idempotent, so a
      // throw from its own `turn_end` emit sends no second `turn_end`.
      this.reportTurnError(error);
      try {
        this.finishTurn(turnId, {
          stopReason: "error",
          error: redactTurnError(error, this.errorPolicy.exposeTurnErrors === true),
        });
      } catch (sinkError) {
        // The state is already final (set before the emit); only the frame is lost.
        this.reportTurnError(sinkError);
      }
    }
  }

  private reportTurnError(error: unknown): void {
    try {
      this.errorPolicy.onTurnError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The embedder's log sink failed: there is nowhere left to report it,
      // and it must not strand the turn as running or reject `drive`.
    }
  }

  /**
   * End the turn: record its outcome, clear the controller, stream `turn_end`.
   * Synchronous, and idempotent per turn. State is set BEFORE the emit, so a
   * throwing sink can never leave the session "running".
   */
  private finishTurn(turnId: string, end: TurnEnd): void {
    const record = this.turns.get(turnId);
    if (!record || record.end) {
      return;
    }
    record.end = end;
    if (this.activeTurnId === turnId) {
      this.controller = null;
      this.activeTurnId = null;
    }
    this.emit({ type: "turn_end", turnId, ...end });
  }

  /**
   * Queue a user message for injection at the next model-round boundary of the
   * turn `turnId`. Synchronous. The key is checked BEFORE the running check: a
   * retry of an accepted id is a no-op success even after its turn ended (never
   * `NoTurnRunning`, never injected twice). A rejected attempt is not recorded.
   */
  enqueue(id: string, turnId: string, text: string): void {
    if (this.enqueued.has(id)) {
      return;
    }
    // Accepting it while idle would be a fake success: the next turn starts by
    // resetting the steering queue, so the text would be dropped silently. And
    // it must be THIS turn: a retry that outlived its turn must not steer the
    // next one.
    if (this.controller === null || this.activeTurnId !== turnId) {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    }
    this.enqueued.add(id);
    this.session.enqueue(text);
  }

  /**
   * Compact the conversation; returns message counts before/after. Takes the
   * busy slot before its first `await` (see `assertIdle`), so it is exclusive
   * with a turn, and `cancel` — or `signal` (the request's own cancel) — aborts
   * it: it then rejects `Cancelled` and leaves the history untouched.
   */
  async compact(signal?: AbortSignal): Promise<{ before: number; after: number }> {
    this.assertIdle();
    // Cancelled before it started: no slot, no model call.
    if (signal?.aborted) {
      throw new RpcError(DomainErrorCode.Cancelled, "compaction cancelled");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.compacting = true;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { before, after } = await this.session.compact(controller.signal);
      return { before, after };
    } catch (error) {
      // Providers throw anything on abort; give the client one clean code.
      if (controller.signal.aborted) {
        throw new RpcError(DomainErrorCode.Cancelled, "compaction cancelled");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // Ours for sure: no one takes the slot without `assertIdle`.
      this.controller = null;
      this.compacting = false;
    }
  }

  /** The current conversation history (the main thread persists it). */
  snapshot(): { messages: readonly ChatMessage[] } {
    return { messages: this.session.snapshot().messages };
  }

  /** Abort the active turn or compaction (if any). */
  cancel(): void {
    this.controller?.abort();
  }

  /** Terminate every background job this session started. */
  disposeJobs(): void {
    this.jobs?.dispose();
  }
}
