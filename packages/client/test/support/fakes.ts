/**
 * Fakes shared by the re-attach tests: a scripted model that can pause at a
 * gate (so the stream is mid-round when a link drops), and a broker whose
 * prompts wait for the test.
 */
import {
  type ChatRequest,
  DISMISSED,
  type ModelProvider,
  PermissionBroker,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";

export type Step =
  | { readonly kind: "event"; readonly event: StreamEvent }
  | { readonly kind: "gate" };

export const t = (delta: string): Step => ({ kind: "event", event: { type: "text", delta } });
export const done: Step = { kind: "event", event: { type: "done" } };

/** A scripted model that pauses at each `gate` until the test releases it. */
export class GatedModel implements ModelProvider {
  readonly id = "gated";
  calls = 0;
  waiting = false;
  private release: (() => void) | null = null;
  constructor(private readonly script: readonly (readonly Step[])[]) {}
  open(): void {
    this.release?.();
  }
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const steps = this.script[this.calls++] ?? [done];
    for (const step of steps) {
      if (step.kind === "gate") {
        this.waiting = true;
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        this.waiting = false;
        this.release = null;
        continue;
      }
      // One event per macrotask: the stream keeps moving while the client
      // reconnects, so live updates race the `open` and the cut moves between
      // the `open` and its snapshot (the overlap seq dedupe must absorb).
      await new Promise((r) => setTimeout(r, 0));
      yield step.event;
    }
  }
}

/** A broker whose prompts wait for the test (`approve`); a withdrawn prompt resolves DISMISSED. */
export function approver() {
  const pending: ((r: PermissionResponse) => void)[] = [];
  let prompts = 0;
  let aborts = 0;
  const broker = new PermissionBroker(
    (_req, options) =>
      new Promise<PermissionResponse>((resolve) => {
        prompts += 1;
        const settle = (r: PermissionResponse): void => {
          const at = pending.indexOf(settle);
          if (at >= 0) pending.splice(at, 1);
          resolve(r);
        };
        pending.push(settle);
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            settle(DISMISSED);
          },
          { once: true },
        );
      }),
  );
  return {
    broker,
    pending: () => pending.length,
    prompts: () => prompts,
    /** Prompts withdrawn by their signal (answered elsewhere, gone). */
    aborts: () => aborts,
    deny: () => pending[0]?.({ allowed: false }),
    approve: () => pending[0]?.({ allowed: true, scope: "once" }),
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 1));

export async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) return false;
    await tick();
  }
  return true;
}
