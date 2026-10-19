/**
 * A remote conversation that presents the *same* interface as the local agent
 * `Session`: `send(text, signal)` yields `AgentEvent`s. The Ink App consumes it
 * unchanged, so a connected TUI renders a remote session identically to a local
 * one. The remote session id is created lazily on the first `send`.
 */
import type { AgentEvent } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import type { SessionUpdate } from "@tentacle/protocol";
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
    if (this.id) {
      return this.client.enqueue(this.id, text);
    }
    if (this.opening) {
      return this.opening.then((id) => this.client.enqueue(id, text));
    }
    return Promise.resolve();
  }

  async *send(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
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

    this.client.setUpdateHandler(id, (update: SessionUpdate) => {
      const event = updateToEvent(update, toolNames);
      if (event) {
        queue.push(event);
      }
    });
    const onAbort = (): void => this.client.cancel(id);
    signal?.addEventListener("abort", onAbort);

    this.client.prompt(id, prompt).then(
      (stopReason) => {
        queue.push({ type: "turn_end", reason: stopReasonFromProtocol(stopReason) });
        queue.close();
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
