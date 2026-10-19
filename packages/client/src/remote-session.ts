/**
 * A remote conversation that presents the *same* interface as the local agent
 * `Session`: `send(text, signal)` yields `AgentEvent`s. The Ink App consumes it
 * unchanged, so a connected TUI renders a remote session identically to a local
 * one. The remote session id is created lazily on the first `send`.
 */
import type { AgentEvent } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { JsonRpcErrorCode, type SessionUpdate, type TurnEnd } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { stopReasonFromProtocol, updateToEvent } from "./mapping.ts";
import { AsyncQueue } from "./queue.ts";
import type { RemoteClient } from "./remote-client.ts";

export class RemoteSession {
  private readonly client: RemoteClient;
  private readonly seedMessages?: readonly ChatMessage[];
  private readonly desiredId?: string;
  private id: string | null = null;
  /** The in-flight `session/new` of the first `send`, until `id` is known. */
  private opening: Promise<string> | null = null;
  /**
   * The client-chosen id of the latest turn (steering binds to it), or null
   * before the first send. Kept after the turn ends ON PURPOSE: a steer typed
   * in the window where the TUI still shows the turn running then reaches the
   * daemon, which rejects it `NoTurnRunning` — so the TUI can say "not queued"
   * instead of the text vanishing in a local no-op.
   */
  private turnId: string | null = null;

  constructor(client: RemoteClient, seedMessages?: readonly ChatMessage[], desiredId?: string) {
    this.client = client;
    this.seedMessages = seedMessages;
    this.desiredId = desiredId;
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

  async *send(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
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
  ): AsyncGenerator<AgentEvent> {
    if (!this.id) {
      this.opening = this.client.openSession(undefined, this.seedMessages, this.desiredId);
      try {
        this.id = await this.opening;
      } finally {
        this.opening = null;
      }
    }
    const id = this.id;
    const queue = new AsyncQueue<AgentEvent>();
    const toolNames = new Map<string, string>();

    // The turn ends from the stream (`turn_end` with OUR turnId), whatever the
    // order of the ack and the turn's updates: a model that yields without
    // awaiting can finish the whole turn before the ack frame is sent.
    const end = (outcome: TurnEnd): void => {
      if (outcome.stopReason === "error") {
        // Same class the old `prompt` rejection had, so the TUI renders it alike.
        queue.fail(
          new RpcError(
            outcome.error?.code ?? JsonRpcErrorCode.InternalError,
            outcome.error?.message ?? "turn failed",
          ),
        );
        return;
      }
      queue.push({ type: "turn_end", reason: stopReasonFromProtocol(outcome.stopReason) });
      queue.close();
    };
    this.client.setUpdateHandler(id, {
      update: (update: SessionUpdate) => {
        if (update.type === "turn_start" || update.type === "turn_end") {
          // Another turn's bracket (not ours) is ignored.
          if (update.type === "turn_end" && update.turnId === turnId) {
            end(update);
          }
          return;
        }
        const event = updateToEvent(update, toolNames);
        if (event) {
          queue.push(event);
        }
      },
      // A frame this client cannot act on (unknown mandatory, malformed): fail
      // the turn loudly, and cancel it so the daemon does not run it unobserved.
      fail: (error: Error) => {
        queue.fail(error);
        this.client.cancel(id);
      },
    });
    const onAbort = (): void => this.client.cancel(id);
    signal?.addEventListener("abort", onAbort);

    this.client.prompt(id, turnId, prompt).then(
      // A plain ack: the stream ends the turn. `ended` (a retried turn that
      // already finished) ends it from the ack; a no-op if the stream did.
      (ack) => {
        if (ack.ended) {
          end(ack.ended);
        }
      },
      (error) => queue.fail(error),
    );

    try {
      yield* queue;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.client.setUpdateHandler(id, null);
    }
  }
}
