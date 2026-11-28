/**
 * The e2e harness's laptop requester (`seed.ts`'s `laptopLink`), as a pure
 * module (docs/fix/mobile-fluidity-e2e.md, flow 34). It HOLDS every ask until a
 * hook answers it, and drops one the daemon withdrew (answered by the phone, or
 * its turn cancelled) — a stale entry once made a later `laptop-prompt` believe
 * its own ask had arrived.
 */
import { DISMISSED, type PermissionRequester, type PermissionResponse } from "@tentacle/core";

/** What a laptop requester answers (`null`: it waits, so only the phone can). */
export type LaptopAnswer = "allow" | "deny";

interface Held {
  readonly turnId: string | undefined;
  readonly answer: (answer: LaptopAnswer) => void;
}

function responseOf(answer: LaptopAnswer): PermissionResponse {
  return answer === "allow" ? { allowed: true, scope: "once" } : { allowed: false };
}

export function createLaptopAnswerer() {
  const pending = new Set<Held>();
  /** The turns a hook said to answer, and with what, while they run. */
  const turns = new Map<string, LaptopAnswer>();

  const requester: PermissionRequester = (_request, options) =>
    new Promise<PermissionResponse>((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        resolve(DISMISSED);
        return;
      }
      const turnId = options?.turnId;
      const registered = turnId === undefined ? undefined : turns.get(turnId);
      if (registered !== undefined) {
        resolve(responseOf(registered));
        return;
      }
      const onAbort = (): void => {
        pending.delete(held);
        resolve(DISMISSED);
      };
      const held: Held = {
        turnId,
        answer: (answer) => {
          pending.delete(held);
          signal?.removeEventListener("abort", onAbort);
          resolve(responseOf(answer));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.add(held);
    });

  /** Resolve every LIVE pending ask (the first answer wins daemon-side). */
  function answerAll(answer: LaptopAnswer): void {
    for (const held of [...pending]) {
      held.answer(answer);
    }
  }

  /**
   * Answer every ask of `turnId` with `answer`, the ones already pending and the
   * ones still to come, until the returned release is called.
   */
  function answerTurn(turnId: string, answer: LaptopAnswer): () => void {
    turns.set(turnId, answer);
    for (const held of [...pending]) {
      if (held.turnId === turnId) {
        held.answer(answer);
      }
    }
    return () => {
      turns.delete(turnId);
    };
  }

  return { requester, answerAll, answerTurn, pendingCount: () => pending.size };
}
