/**
 * Transparent retry of a model call whose connection drops before any output.
 *
 * Wraps any `ModelProvider` (applied by `createModelProvider`, so both wire
 * formats, the sub-agents and the laptop side of the pod tunnel share it). The
 * safe boundary is "no event emitted yet": until the first `StreamEvent` no
 * consumer has seen output, so a new attempt is indistinguishable from a first
 * one. Bun's error does not tell the phase (a reset before the response and one
 * mid-body are identical), so the phase is tracked here, by emission.
 *
 * Only transient connection errors (a string `code` on the allowlist) are
 * retried. HTTP statuses (`ModelRequestError`), a cancel (`AbortError`, whose
 * `code` is numeric) and anything else pass through untouched. A drop after
 * output has started is never retried (it would duplicate what was shown): it
 * surfaces as a `ModelConnectionError` that names the phase.
 */
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";

/** Connection-level failure codes worth another attempt. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
]);

/** The error's code when it is a transient connection failure, else `undefined`. */
export function transientConnectionCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && TRANSIENT_CODES.has(code) ? code : undefined;
}

/** Where the connection dropped: before any event was delivered, or after. */
export type ConnectionPhase = "pre-stream" | "mid-stream";

/**
 * A transient connection failure that was not (or no longer) retried.
 *
 * "pre-stream" means no event had been DELIVERED to the consumer — not that the
 * model had generated nothing: a provider holds tool calls until the turn's
 * stop reason, so a drop mid tool call is pre-stream (and was regenerated).
 */
export class ModelConnectionError extends Error {
  constructor(
    readonly code: string,
    readonly phase: ConnectionPhase,
    readonly attempt: number,
    readonly maxAttempts: number,
    cause: unknown,
  ) {
    const original = cause instanceof Error ? cause.message : String(cause);
    super(`${connectionFailureSummary(code, phase, attempt, maxAttempts)}: ${original}`, { cause });
    this.name = "ModelConnectionError";
  }
}

function connectionFailureSummary(
  code: string,
  phase: ConnectionPhase,
  attempt: number,
  maxAttempts: number,
): string {
  if (phase === "mid-stream") {
    return `model connection lost mid-stream (${code}) on attempt ${attempt}/${maxAttempts} — not retried, events were already delivered`;
  }
  // Refused: no connection ever existed, so nothing was "lost".
  const what =
    code === "ECONNREFUSED"
      ? "could not connect to the model endpoint"
      : "model connection lost before any event was delivered";
  return `${what} (${code}), gave up after ${attempt} attempt(s)`;
}

/** Reported before each retry's wait (a recovered blip leaves only this trace). */
export interface RetryInfo {
  /** The attempt that failed (1-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly code: string;
  readonly delayMs: number;
  readonly providerId: string;
}

export interface RetryPolicy {
  /** Total attempts, the first included. Default 3. */
  readonly maxAttempts?: number;
  /** Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Default 4 s. */
  readonly capDelayMs?: number;
  /** Best-effort: a throw is ignored and the retry goes on. */
  readonly onRetry?: (info: RetryInfo) => void;
  /** Injectable for tests. Must reject at once when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_CAP_DELAY_MS = 4000;

/**
 * "Equal jitter": half the exponential step guaranteed, half random, so there
 * is always a short pause and concurrent callers (a parent and its sub-agent
 * dropped together) do not retry in lockstep. Defaults: retry 1 in [250, 500)
 * ms, retry 2 in [500, 1000) ms.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  capDelayMs: number,
  random: () => number,
): number {
  const step = Math.min(capDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(step / 2 + random() * (step / 2));
}

/** A timer that rejects with the abort reason as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class RetryingModelProvider implements ModelProvider {
  readonly id: string;

  constructor(
    readonly inner: ModelProvider,
    private readonly policy: RetryPolicy = {},
  ) {
    this.id = inner.id;
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const maxAttempts = this.policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const sleep = this.policy.sleep ?? abortableSleep;
    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        for await (const event of this.inner.stream(request)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const code = transientConnectionCode(error);
        // A cancel wins over everything, and a non-transient error is not
        // ours to judge: both leave exactly as they came.
        if (request.signal?.aborted || code === undefined) {
          throw error;
        }
        if (emitted) {
          throw new ModelConnectionError(code, "mid-stream", attempt, maxAttempts, error);
        }
        if (attempt >= maxAttempts) {
          throw new ModelConnectionError(code, "pre-stream", attempt, maxAttempts, error);
        }
        const delayMs = backoffDelay(
          attempt,
          this.policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
          this.policy.capDelayMs ?? DEFAULT_CAP_DELAY_MS,
          this.policy.random ?? Math.random,
        );
        try {
          this.policy.onRetry?.({ attempt, maxAttempts, code, delayMs, providerId: this.id });
        } catch {
          // A failing log sink must not cost the user the turn.
        }
        await sleep(delayMs, request.signal);
      }
    }
  }
}
