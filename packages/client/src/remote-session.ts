/**
 * A remote conversation that presents the *same* interface as the local agent
 * `Session`: `send(text, signal)` yields `AgentEvent`s — plus, after a
 * reconnect that had to resync, a `history_reset` (replace what is shown) and
 * a `user_message` (the turn's prompt, re-delivered after the reset). The Ink
 * App folds them, so a connected TUI renders a remote session identically to a
 * local one. The remote session id is created lazily on the first `send`;
 * `close` ends it daemon-side (a session outlives the connection that opened
 * it). It is its session's stream listener: `RemoteClient` hands it the
 * ordered outputs of the pure reducer.
 */
import type { ChatMessage } from "@tentacle/core";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type SendNowMessage,
  type SendNowTarget,
  type SessionUpdate,
  type TurnEnd,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { turnRecovery } from "./link-machine.ts";
import { type SessionEvent, stopReasonFromProtocol, updateToEvent } from "./mapping.ts";
import { AsyncQueue } from "./queue.ts";
import type { RemoteClient, SessionStreamListener } from "./remote-client.ts";
import type { StreamOutput } from "./session-reducer.ts";

/** The turn this session is streaming. */
interface ActiveTurn {
  readonly turnId: string;
  readonly prompt: string;
  /** The user's `/name` activation, re-sent with the prompt. */
  readonly skill?: string;
  readonly queue: AsyncQueue<SessionEvent>;
  /** Tool names by call id (a `tool_call_update` omits it). */
  readonly toolNames: Map<string, string>;
  /** Calls the last reset already showed: their replayed `tool_call` is not shown again. */
  shownTools: Set<string>;
  /** A reset replaced the screen during this turn. */
  reset: boolean;
  ended: boolean;
  /** The daemon acknowledged `prompt{turnId}`. */
  acked: boolean;
  /** `prompt{turnId}` was written to a channel: a daemon may have run it. */
  sent: boolean;
  /** The user cancelled; re-sent on the prompt's ack (a cancel can beat the prompt, or be lost). */
  abortWanted: boolean;
  /** Set for a turn started by `session/send_now` (its request is re-sent instead of `prompt`). */
  readonly sendNow?: {
    readonly interrupt: SendNowTarget;
    readonly messages: readonly SendNowMessage[];
  };
  /**
   * A send-now turn's `turn_start` was seen (or a reset showed it running).
   * Only the fallback when its end carries no `delivered` (an older daemon).
   */
  started: boolean;
}

export class RemoteSession implements SessionStreamListener {
  private readonly client: RemoteClient;
  private readonly seedMessages?: readonly ChatMessage[];
  private readonly desiredId?: string;
  private id: string | null = null;
  /** The in-flight `session/open` of the first `send`, until `id` is known. */
  private opening: Promise<string> | null = null;
  private closed = false;
  /**
   * The client-chosen id of the latest turn (steering binds to it), or null
   * before the first send. Kept after the turn ends ON PURPOSE: a steer typed
   * in the window where the TUI still shows the turn running then reaches the
   * daemon, which rejects it `NoTurnRunning` — so the TUI can say "not queued"
   * instead of the text vanishing in a local no-op.
   */
  private turnId: string | null = null;
  /** The turn being streamed, or null when idle. */
  private active: ActiveTurn | null = null;
  /**
   * A send-now turn waiting for `active` to end: promoted (and `turnId`
   * switched) when it does. The daemon emits the old `turn_end` before any
   * update of its successor, so routing by order stays correct.
   */
  private next: ActiveTurn | null = null;
  /**
   * The old turn a resync past the hand-off promoted away from: its
   * `turn_end` is behind the cut, so it waits for its real end from its
   * re-sent `prompt` (`recovered`), which the daemon answers from its cache.
   */
  private settling: ActiveTurn | null = null;
  /** `unsupported` notices that arrived while idle: shown at the start of the next turn. */
  private idleNotices: SessionEvent[] = [];

  constructor(client: RemoteClient, seedMessages?: readonly ChatMessage[], desiredId?: string) {
    this.client = client;
    this.seedMessages = seedMessages;
    this.desiredId = desiredId;
  }

  /**
   * End the remote session daemon-side (its turn, its background jobs): the
   * TUI's `/clear`. Idempotent; fire-and-forget. While the first `send` is
   * still opening it, the close follows the open. A no-op before any send.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.id) {
      void this.client.closeSession(this.id);
    } else if (this.opening) {
      this.opening.then(
        (id) => this.client.closeSession(id),
        () => {},
      );
    }
  }

  /** Compact the remote conversation (no-op if no session was opened yet). */
  async compact(): Promise<{ before: number; after: number }> {
    if (!this.id) {
      return { before: 0, after: 0 };
    }
    return this.client.compact(this.id);
  }

  /** The remote session's current history, or null if none was opened yet. */
  async snapshot(): Promise<readonly ChatMessage[] | null> {
    return this.id ? this.client.snapshot(this.id) : null;
  }

  /**
   * Queue a user message mid-turn (steering). Resolves when the daemon has
   * accepted it; REJECTS on a delivery failure (e.g. `MethodNotFound` from an
   * older remote daemon, or a transport drop) so the caller can reconcile its
   * optimistic pending entry. While the first send is still opening the
   * session it waits for the id (the turn is already running for the caller);
   * a no-op (resolved) before any send. `id`: the caller's key for this text
   * (a later `sendNow` cites it); a fresh one when omitted.
   */
  enqueue(text: string, id?: string): Promise<void> {
    const turnId = this.turnId;
    if (turnId === null) {
      return Promise.resolve();
    }
    const key = id ?? crypto.randomUUID();
    if (this.id) {
      return this.client.enqueue(this.id, key, turnId, text);
    }
    if (this.opening) {
      return this.opening.then((id) => this.client.enqueue(id, key, turnId, text));
    }
    return Promise.resolve();
  }

  /** `opts.skill`: the user activates that skill (`/name`) with this prompt. */
  async *send(
    prompt: string,
    signal?: AbortSignal,
    opts: { readonly skill?: string } = {},
  ): AsyncGenerator<SessionEvent> {
    // Known before the first `await`, so a steer typed while the session is
    // still opening is already bound to this turn.
    const turnId = crypto.randomUUID();
    this.turnId = turnId;
    yield* this.runTurn(turnId, prompt, signal, opts.skill);
  }

  /**
   * `session/send_now`: cancel the running turn (`target: "turn"`) or
   * compaction and start a new turn whose prompt is `messages` (`id`: the
   * `enqueue` key, if it was enqueued). Resolves on the daemon's ack with the
   * new turn's events: a `user_message` with the prompt the daemon actually
   * sent (none for a continuation, prompt ""), then the turn as `send` yields
   * it. REJECTS, with nothing changed, on a refusal: `MethodNotFound` (an
   * older daemon), `TurnInProgress`, `NoTurnRunning` (also locally: no turn
   * to interrupt, no session yet), `InvalidParams` (no messages). The events
   * reject `Cancelled` if the turn was cancelled before it started: it
   * delivered nothing, so the caller restores its texts. Enqueues keep binding
   * to the old turn until it ends (the daemon carries them over).
   */
  async sendNow(
    messages: readonly SendNowMessage[],
    target: "turn" | "compaction",
    signal?: AbortSignal,
  ): Promise<AsyncIterable<SessionEvent>> {
    if (messages.length === 0) {
      throw new RpcError(JsonRpcErrorCode.InvalidParams, "send-now needs at least one message");
    }
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, "this session was closed");
    }
    const id = this.id;
    const current = this.active && !this.active.ended ? this.active : null;
    if (!id || (target === "turn" && (this.turnId === null || !current))) {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    }
    if (this.next) {
      throw new RpcError(DomainErrorCode.TurnInProgress, "a send-now is already waiting");
    }
    const interrupt: SendNowTarget =
      target === "turn" && this.turnId !== null
        ? { kind: "turn", turnId: this.turnId }
        : { kind: "compaction" };
    const turn: ActiveTurn = {
      turnId: crypto.randomUUID(),
      prompt: "",
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      sent: false,
      abortWanted: false,
      sendNow: { interrupt, messages: [...messages] },
      started: false,
    };
    // Installed BEFORE the request goes out: the daemon may hand over (old
    // `turn_end`, then this turn's updates) before its ack arrives.
    const before = this.turnId;
    if (current) {
      this.next = turn;
    } else {
      this.install(turn);
    }
    // Esc cancels it like `send`'s, also before the ack (re-sent on the ack:
    // only then does the daemon hold the new turn) or before the caller iterates.
    const onAbort = (): void => {
      turn.abortWanted = true;
      this.client.cancel(id);
    };
    signal?.addEventListener("abort", onAbort);
    try {
      await new Promise<void>((resolve, reject) => {
        this.sendPrompt(id, turn, (error) => (error === undefined ? resolve() : reject(error)));
      });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      // Refused: the client is left as before the call.
      if (this.next === turn) {
        this.next = null;
      }
      if (this.active === turn) {
        // Installed (no turn to wait for, or promoted at the old turn's end):
        // its `unsupported` notices (idle ones it took, any since) go back to
        // the idle list, never dropped; nobody iterated its queue.
        this.active = null;
        this.turnId = before;
        const notices = turn.queue.takeBuffered().filter((e) => e.type === "unsupported");
        this.idleNotices = [...notices, ...this.idleNotices];
      }
      throw error;
    }
    return this.stream(turn, () => signal?.removeEventListener("abort", onAbort));
  }

  /** A send-now turn's events, until its end. */
  private async *stream(turn: ActiveTurn, done: () => void): AsyncGenerator<SessionEvent> {
    try {
      yield* turn.queue;
    } finally {
      done();
      if (this.active === turn) {
        this.active = null;
      }
    }
  }

  /** `turn` becomes the streamed one: steering binds to it from now on. */
  private install(turn: ActiveTurn): void {
    this.active = turn;
    this.turnId = turn.turnId;
    for (const notice of this.idleNotices.splice(0)) {
      turn.queue.push(notice);
    }
  }

  /** `ended` was the active turn: hand the stream to the waiting send-now, if any. */
  private promote(ended: ActiveTurn): void {
    if (this.settling === ended) {
      this.settling = null; // its real end arrived: nothing to hand over
      return;
    }
    const next = this.next;
    if (next && this.active === ended) {
      this.next = null;
      this.install(next);
    }
  }

  private async *runTurn(
    turnId: string,
    prompt: string,
    signal?: AbortSignal,
    skill?: string,
  ): AsyncGenerator<SessionEvent> {
    if (this.closed) {
      throw new RpcError(DomainErrorCode.UnknownSession, "this session was closed");
    }
    if (!this.id) {
      this.opening = this.client.openSession(undefined, this.seedMessages, this.desiredId, this);
      try {
        this.id = await this.opening;
      } finally {
        this.opening = null;
      }
      this.client.setListener(this.id, this);
    }
    const id = this.id;
    const turn: ActiveTurn = {
      turnId,
      prompt,
      ...(skill !== undefined ? { skill } : {}),
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      sent: false,
      abortWanted: false,
      started: false,
    };
    this.active = turn;
    for (const notice of this.idleNotices.splice(0)) {
      turn.queue.push(notice);
    }
    const onAbort = (): void => {
      turn.abortWanted = true;
      this.client.cancel(id);
    };
    signal?.addEventListener("abort", onAbort);
    this.sendPrompt(id, turn);
    try {
      yield* turn.queue;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active === turn) {
        this.active = null;
      }
    }
  }

  /**
   * `prompt{turnId}`, or `send_now{turnId}` for a send-now turn (re-sent with
   * the same key after a drop: the daemon runs it once). `settled`: called
   * once the request is answered (no argument) or refused (the error).
   */
  private sendPrompt(id: string, turn: ActiveTurn, settled?: (error?: unknown) => void): void {
    const sent = (): void => {
      turn.sent = true;
    };
    const request = turn.sendNow
      ? this.client.sendNow(id, turn.turnId, turn.sendNow.interrupt, turn.sendNow.messages, sent)
      : this.client.prompt(id, turn.turnId, turn.prompt, sent, turn.skill);
    request.then(
      // A plain ack: the stream ends the turn. `ended` (a retried turn that
      // already finished — also while this client was away) ends it from the
      // ack; a no-op if the stream did.
      (ack) => {
        turn.acked = true;
        if (ack.ended) {
          this.finish(turn, ack.ended);
        } else if (turn.abortWanted) {
          // Esc before the daemon had the turn (e.g. while the link was down):
          // that cancel found nothing to cancel; now it does.
          this.client.cancel(id);
        }
        settled?.();
      },
      (error) => {
        this.fail(turn, error);
        settled?.(error);
      },
    );
  }

  // --- the session's stream (SessionStreamListener) -----------------------

  /** One ordered output of the session's stream, for the turn in flight (if any). */
  output(out: StreamOutput): void {
    const old = this.active;
    const next = this.next;
    if (old && !old.ended && next && out.kind === "reset" && out.turn === next.turnId) {
      // A resync whose cut is past the hand-off: the old turn's `turn_end` is
      // behind the cut and will never stream. The successor takes the stream
      // now; the old turn ends with its REAL outcome from its re-sent prompt's
      // `ended` (`recovered` runs right after this reset). It is never guessed:
      // the successor started, so the daemon has the old turn's end cached.
      this.settling = old;
      this.next = null;
      this.install(next);
    }
    const turn = this.active;
    if (!turn || turn.ended) {
      // The reducer reports an unknown type once: keep it for the next turn,
      // never drop it (docs/feat/protocol-v10-forward-compat.md).
      if (out.kind === "unsupported") {
        this.idleNotices.push({ type: "unsupported", kind: out.type });
      }
      return; // idle: a turn started elsewhere is not rendered (known limit)
    }
    switch (out.kind) {
      case "reset": {
        // Everything shown is replaced by the snapshot; tool calls it already
        // lists are re-announced by the replay — shown once (upsert).
        turn.reset = true;
        if (out.turn === turn.turnId) {
          turn.started = true; // running at the cut: its prompt is in the snapshot
        }
        turn.shownTools = new Set(
          out.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)),
        );
        for (const m of out.messages) {
          for (const call of m.toolCalls ?? []) turn.toolNames.set(call.id, call.name);
        }
        turn.queue.push({ type: "history_reset", messages: out.messages });
        return;
      }
      case "update":
        this.onUpdate(turn, out.update);
        return;
      case "error":
        // A frame this client cannot act on (unknown mandatory, malformed):
        // fail the turn loudly, and cancel it so the daemon does not run it
        // unobserved (the cancel also reaches a waiting send-now: fail it too).
        this.failAll(out.error);
        if (this.id) this.client.cancel(this.id);
        return;
      case "unsupported":
        turn.queue.push({ type: "unsupported", kind: out.type });
        return;
      case "turn_lost":
        // A settling old turn is not failed here: its re-sent `prompt` is in
        // flight, and `sessionCall` rejects it (a keyed call never crosses a
        // recreate), which fails it through `sendPrompt`.
        // The active turn, then (promoted by its failure) a waiting send-now.
        for (let lost = this.active; lost && !lost.ended; lost = this.active) {
          if (!lost.sent) {
            // Typed while the link was down: no daemon ever had it, so it is
            // not lost — it goes to the recreated session (`sessionCall`).
            return;
          }
          this.fail(
            lost,
            new RpcError(
              DomainErrorCode.UnknownSession,
              "the daemon lost the session; the turn in flight was not re-run",
            ),
          );
        }
        return;
      case "failed":
        this.failAll(new Error(out.reason));
        return;
    }
  }

  /** Back after a drop or a forced reopen: re-send what the link may have lost. */
  recovered(info: { readonly recreated: boolean }): void {
    const id = this.id;
    if (!id) {
      return;
    }
    // The old turn first: its ack can end it (and promote the send-now). A
    // settling old turn learns its real end the same way.
    for (const turn of [this.settling, this.active, this.next]) {
      if (turn && turnRecovery({ ...info, ended: turn.ended, acked: turn.acked }).resendPrompt) {
        this.sendPrompt(id, turn);
      }
    }
  }

  /** The link is gone for good: the turn's outcome can never arrive. */
  linkClosed(error: Error): void {
    this.failAll(error);
  }

  /**
   * Fail the active turn, then the send-now its failure promoted. A settling
   * old turn is left to its in-flight `prompt`: on a dead link or a failed
   * session `sessionCall` rejects it (`whenLive`); on an `error` frame (the
   * link is fine) its real end still arrives — failing it would be a guess.
   */
  private failAll(error: unknown): void {
    for (let turn = this.active; turn && !turn.ended; turn = this.active) {
      this.fail(turn, error);
    }
  }

  private onUpdate(turn: ActiveTurn, update: SessionUpdate): void {
    // Closed (by another client): ours already got `turn_end{cancelled}`
    // before it; fail loudly anyway rather than ever wait on a dead session.
    if (update.type === "session_closed") {
      this.fail(turn, new RpcError(DomainErrorCode.UnknownSession, "the session was closed"));
      return;
    }
    if (update.type === "turn_start") {
      // Our own prompt is already on screen — unless a reset replaced the
      // screen before the replay re-delivered it. A send-now's prompt is never
      // on screen: the daemon's is what it sent (texts it injected meanwhile
      // are left out; "" for a continuation). Another turn's: ignored.
      if (update.turnId === turn.turnId) {
        if (turn.sendNow) {
          turn.started = true;
        }
        if ((turn.sendNow || turn.reset) && update.prompt !== "") {
          turn.queue.push({ type: "user_message", text: update.prompt });
        }
      }
      return;
    }
    if (update.type === "turn_end") {
      if (update.turnId === turn.turnId) {
        this.finish(turn, update);
      }
      return;
    }
    // Owned elsewhere: the permission router (the dialog) and the job-exit
    // listeners (they fire even while idle).
    if (
      update.type === "permission_request" ||
      update.type === "permission_resolved" ||
      update.type === "background_exit"
    ) {
      return;
    }
    if (update.type === "tool_call" && turn.shownTools.has(update.toolCallId)) {
      turn.toolNames.set(update.toolCallId, update.title);
      return; // already shown by the reset
    }
    const event = updateToEvent(update, turn.toolNames);
    if (event) {
      turn.queue.push(event);
    }
  }

  // The turn ends from the stream (`turn_end` with OUR turnId), whatever the
  // order of the ack and the turn's updates: a model that yields without
  // awaiting can finish the whole turn before the ack frame is sent.
  private end(turn: ActiveTurn, outcome: TurnEnd): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    if (outcome.stopReason === "error") {
      // Same class the old `prompt` rejection had, so the TUI renders it alike.
      turn.queue.fail(
        new RpcError(
          outcome.error?.code ?? JsonRpcErrorCode.InternalError,
          outcome.error?.message ?? "turn failed",
        ),
      );
    } else {
      turn.queue.push({ type: "turn_end", reason: stopReasonFromProtocol(outcome.stopReason) });
      turn.queue.close();
    }
    this.promote(turn);
  }

  /**
   * The daemon's end of `turn` (stream or ack). A send-now turn cancelled
   * before it started delivered nothing (the `session/send_now` contract):
   * its events reject `Cancelled` so the caller restores its texts. The end's
   * `delivered` is the daemon's fact and decides; a seen `turn_start` is only
   * the fallback for an older daemon (no field) — a resync can hide one, so
   * the fallback restores rather than risk a loss.
   */
  private finish(turn: ActiveTurn, outcome: TurnEnd): void {
    const undelivered =
      outcome.delivered !== undefined
        ? !outcome.delivered
        : !turn.started && outcome.stopReason === "cancelled";
    if (turn.sendNow && undelivered) {
      this.fail(
        turn,
        new RpcError(DomainErrorCode.Cancelled, "send-now cancelled before it started"),
      );
      return;
    }
    this.end(turn, outcome);
  }

  private fail(turn: ActiveTurn, error: unknown): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    turn.queue.fail(error);
    this.promote(turn);
  }
}
