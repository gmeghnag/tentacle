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
  /** The user cancelled; re-sent on the prompt's ack (a cancel can beat the prompt, or be lost). */
  abortWanted: boolean;
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
   * a no-op (resolved) before any send.
   */
  enqueue(text: string): Promise<void> {
    const turnId = this.turnId;
    if (turnId === null) {
      return Promise.resolve();
    }
    const key = crypto.randomUUID();
    if (this.id) {
      return this.client.enqueue(this.id, key, turnId, text);
    }
    if (this.opening) {
      return this.opening.then((id) => this.client.enqueue(id, key, turnId, text));
    }
    return Promise.resolve();
  }

  async *send(prompt: string, signal?: AbortSignal): AsyncGenerator<SessionEvent> {
    // Known before the first `await`, so a steer typed while the session is
    // still opening is already bound to this turn.
    const turnId = crypto.randomUUID();
    this.turnId = turnId;
    yield* this.runTurn(turnId, prompt, signal);
  }

  private async *runTurn(
    turnId: string,
    prompt: string,
    signal?: AbortSignal,
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
      queue: new AsyncQueue<SessionEvent>(),
      toolNames: new Map(),
      shownTools: new Set(),
      reset: false,
      ended: false,
      acked: false,
      abortWanted: false,
    };
    this.active = turn;
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

  /** `prompt{turnId}` (re-sent with the same key after a drop: the daemon runs it once). */
  private sendPrompt(id: string, turn: ActiveTurn): void {
    this.client.prompt(id, turn.turnId, turn.prompt).then(
      // A plain ack: the stream ends the turn. `ended` (a retried turn that
      // already finished — also while this client was away) ends it from the
      // ack; a no-op if the stream did.
      (ack) => {
        turn.acked = true;
        if (ack.ended) {
          this.end(turn, ack.ended);
        } else if (turn.abortWanted) {
          // Esc before the daemon had the turn (e.g. while the link was down):
          // that cancel found nothing to cancel; now it does.
          this.client.cancel(id);
        }
      },
      (error) => this.fail(turn, error),
    );
  }

  // --- the session's stream (SessionStreamListener) -----------------------

  /** One ordered output of the session's stream, for the turn in flight (if any). */
  output(out: StreamOutput): void {
    const turn = this.active;
    if (!turn || turn.ended) {
      return; // idle: a turn started elsewhere is not rendered (known limit)
    }
    switch (out.kind) {
      case "reset": {
        // Everything shown is replaced by the snapshot; tool calls it already
        // lists are re-announced by the replay — shown once (upsert).
        turn.reset = true;
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
        // unobserved.
        this.fail(turn, out.error);
        if (this.id) this.client.cancel(this.id);
        return;
      case "turn_lost":
        this.fail(
          turn,
          new RpcError(
            DomainErrorCode.UnknownSession,
            "the daemon lost the session; the turn in flight was not re-run",
          ),
        );
        return;
      case "failed":
        this.fail(turn, new Error(out.reason));
        return;
    }
  }

  /** Back after a drop or a forced reopen: re-send what the link may have lost. */
  recovered(info: { readonly recreated: boolean }): void {
    const turn = this.active;
    const id = this.id;
    if (!turn || !id) {
      return;
    }
    const todo = turnRecovery({ ...info, ended: turn.ended, acked: turn.acked });
    if (todo.resendPrompt) {
      this.sendPrompt(id, turn);
    }
  }

  /** The link is gone for good: the turn's outcome can never arrive. */
  linkClosed(error: Error): void {
    const turn = this.active;
    if (turn) {
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
      // screen before the replay re-delivered it. Another turn's: ignored.
      if (update.turnId === turn.turnId && turn.reset && update.prompt !== "") {
        turn.queue.push({ type: "user_message", text: update.prompt });
      }
      return;
    }
    if (update.type === "turn_end") {
      if (update.turnId === turn.turnId) {
        this.end(turn, update);
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
      return;
    }
    turn.queue.push({ type: "turn_end", reason: stopReasonFromProtocol(outcome.stopReason) });
    turn.queue.close();
  }

  private fail(turn: ActiveTurn, error: unknown): void {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    turn.queue.fail(error);
  }
}
