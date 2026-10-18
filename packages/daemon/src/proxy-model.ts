/**
 * A `ModelProvider` that tunnels each model call to the connected client over
 * the RPC channel (the pod reverse-tunnel, F4.d). The daemon runs the agent
 * loop locally but asks the client — the laptop — to actually reach the model,
 * so the model endpoint and API key never leave the laptop.
 *
 * Two transports, chosen per connection:
 *  - **batch** (`model/stream`): the laptop returns the whole turn's events in
 *    one response (the first cut; still served so an old laptop works).
 *  - **chunked** (`model/streamChunked`): the laptop streams the events as
 *    `$/progress` notifications (each a small batch) tied to the request id and
 *    replies with only a frame count. This provider yields the events as they arrive (a queue), so the
 *    TUI sees tokens as the model produces them instead of after the whole
 *    round. On a `MethodNotFound` from an old laptop it probes once, latches,
 *    and falls back to the batch path for the rest of the connection.
 *
 * The chunked path is loud, never silent: a `seq` gap, a duplicate `seq`, or a
 * result whose `chunks` does not match what was received throws (after
 * draining what was queued), so a reply is never silently truncated.
 */
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { JsonRpcErrorCode, ModelStreamProgressValueSchema } from "@tentacle/protocol";
import type {
  ModelStreamChunkedResult,
  ModelStreamResult,
  WireChatRequest,
} from "@tentacle/protocol";
import { cancelledError } from "@tentacle/transport";

/** Sends a `model/stream` request to the client and resolves with its events. */
export type ModelStreamSender = (request: WireChatRequest) => Promise<ModelStreamResult>;

/**
 * Sends a `model/streamChunked` request to the client. `onProgress` receives
 * each `$/progress` frame's value (a batch of wire events) in `seq` order; the
 * returned promise resolves with the final `{ chunks }` (frames) once the
 * laptop is done.
 */
export type ModelStreamChunkedSender = (
  request: WireChatRequest,
  handlers: {
    readonly signal?: AbortSignal;
    readonly onProgress: (value: unknown, seq: number) => void;
  },
) => Promise<ModelStreamChunkedResult>;

function toWireRequest(request: ChatRequest): WireChatRequest {
  return {
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            toolCalls: m.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          }
        : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
  };
}

/**
 * A small unbounded single-consumer queue. `push`/`close`/`fail` are idempotent
 * once settled; `push` after settlement is dropped. The consumer iterates with
 * `for await` and sees queued items, then the close/error. Unbounded by design:
 * model deltas are tiny and the agent loop reads concurrently as they arrive,
 * so back-pressuring `onProgress` would (wrongly) stall the peer's routing.
 */
class EventQueue {
  private readonly items: StreamEvent[] = [];
  private waiter: ((r: IteratorResult<StreamEvent>) => void) | null = null;
  private settled = false;
  private failure: unknown = null;

  push(item: StreamEvent): void {
    if (this.settled) {
      return; // late (post-settle) chunk: dropped, non-fatal
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as StreamEvent;
        continue;
      }
      if (this.settled) {
        if (this.failure !== null) {
          throw this.failure;
        }
        return;
      }
      const result = await new Promise<IteratorResult<StreamEvent>>((resolve) => {
        this.waiter = resolve;
      });
      if (result.done) {
        if (this.failure !== null) {
          throw this.failure;
        }
        return;
      }
      yield result.value;
    }
  }
}

export class ProxyModelProvider implements ModelProvider {
  readonly id = "proxy";
  private chunked: "unknown" | "no" = "unknown";

  constructor(
    private readonly send: ModelStreamSender,
    private readonly sendChunked?: ModelStreamChunkedSender,
  ) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const wire = toWireRequest(request);
    if (this.chunked !== "no" && this.sendChunked) {
      try {
        yield* this.streamChunked(wire, request.signal);
        return;
      } catch (error) {
        // A MethodNotFound means the laptop is old and lacks
        // `model/streamChunked`: latch the connection to the batch path and
        // retry this same call. Any other error is a genuine failure —
        // propagate it, never fall back silently.
        if (isMethodNotFound(error)) {
          this.chunked = "no";
        } else {
          throw error;
        }
      }
    }
    const { events } = await this.send(wire);
    for (const event of events) {
      yield event as StreamEvent;
    }
  }

  private streamChunked(wire: WireChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const queue = new EventQueue();
    let received = 0;
    let nextSeq = 0;
    let cancelled = false;
    const sender = this.sendChunked as ModelStreamChunkedSender;
    // End the queue once (idempotent) and drop the abort listener so it cannot
    // outlive the stream.
    // The tunnel request owns its abort: the caller's cancel is forwarded into
    // it, and a corrupt stream (gap/dup/invalid batch) aborts it too, so the
    // laptop request is cancelled and the user's local model stops instead of
    // generating for nobody. Present even with no caller signal (compaction).
    const tunnel = new AbortController();
    const finish = (kind: "close" | "fail", error?: unknown): void => {
      signal?.removeEventListener("abort", onAbort);
      if (kind === "close") {
        queue.close();
      } else {
        queue.fail(error);
      }
    };
    const fail = (error: Error): void => {
      finish("fail", error);
      tunnel.abort();
    };
    let onAbort = (): void => {};
    if (signal && !signal.aborted) {
      onAbort = (): void => {
        cancelled = true;
        finish("fail", cancelledError());
        tunnel.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    } else if (signal?.aborted) {
      // Aborted before the call: end it as a cancel (the agent maps the drain
      // to a clean `cancelled` turn); the request is never sent.
      cancelled = true;
      queue.fail(cancelledError());
      tunnel.abort();
    }
    const promise = sender(wire, {
      signal: tunnel.signal,
      onProgress: (value, seq) => {
        // Loud correctness: seq must be exactly the next one, and the payload
        // must be a valid wire event. A gap/dup/invalid is a thrown error,
        // never a silent truncation.
        if (seq !== nextSeq) {
          fail(new Error(`model/streamChunked seq out of order: got ${seq}, expected ${nextSeq}`));
          return;
        }
        nextSeq += 1;
        const parsed = ModelStreamProgressValueSchema.safeParse(value);
        if (!parsed.success) {
          fail(new Error(`model/streamChunked: invalid event batch at seq ${seq}`));
          return;
        }
        received += 1;
        for (const event of parsed.data) {
          queue.push(event as StreamEvent);
        }
      },
    });
    // Concurrency is the point of the fix: the promise runs in the background
    // while the consumer (`for await`) yields events as they arrive. We do NOT
    // `await` it before returning the iterable.
    promise.then(
      (result) => {
        if (result.chunks !== received) {
          finish(
            "fail",
            new Error(
              `model/streamChunked count mismatch: result says ${result.chunks} chunks, received ${received}`,
            ),
          );
          return;
        }
        finish("close");
      },
      (error: unknown) => {
        // A cancel is not a failure for the consumer: the agent's own signal is
        // already aborted and it maps the drain to a clean `cancelled` turn.
        if (cancelled) {
          finish("close");
        } else {
          finish("fail", error);
        }
      },
    );
    return queue;
  }
}

function isMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === JsonRpcErrorCode.MethodNotFound
  );
}
