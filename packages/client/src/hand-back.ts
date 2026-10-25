/**
 * Which returned rows this client gives back to its user, and which it
 * reclaims (docs/feat/queued-broadcast.md). Pure.
 *
 * A row is MINE iff this session sent its id (`mine`: id → the text I typed).
 * The text given back is always my own, from `mine`, never the daemon's: a pod
 * daemon is not trusted (AGENTS §7) — it can name ids, it cannot put words in
 * my input. An id I never sent is ignored, however it is worded. A row already
 * given back by any path (`handedBack`: a refused send-now, a send-now that
 * never started, an earlier state) is only reclaimed, never given twice. A row
 * a live send-now of mine carries (`carried`) is only reclaimed too: every end
 * of that send-now already covers it (sent; or restored by its caller on a
 * refusal or a turn that never started) — given back as well, it would be
 * both in my input and sent (a crash-returned row, owner Q2).
 */
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type QueueState,
  type ReturnCause,
} from "@tentacle/protocol";

/** A row back with me: my id, my text, why (the daemon's fact, for the notice). */
export interface ReturnedRow {
  readonly id: string;
  readonly text: string;
  readonly cause: ReturnCause;
}

export function handBack(
  state: QueueState,
  mine: ReadonlyMap<string, string>,
  handedBack: ReadonlySet<string>,
  carried: ReadonlySet<string> = new Set(),
): { readonly give: readonly ReturnedRow[]; readonly reclaim: readonly string[] } {
  const give: ReturnedRow[] = [];
  const reclaim: string[] = [];
  const seen = new Set<string>();
  for (const row of state.returned) {
    const text = mine.get(row.id);
    if (text === undefined || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    reclaim.push(row.id);
    if (!handedBack.has(row.id) && !carried.has(row.id)) {
      give.push({ id: row.id, text, cause: row.cause });
    }
  }
  return { give, reclaim };
}

/**
 * The ids a refused `session/send_now` gives back to its caller — what the
 * TUI restores (its `planRefusal`), so this client never gives them twice:
 * none for `MethodNotFound` (an older daemon: the fallback sends them) or
 * `NoTurnRunning` (the daemon has them all); otherwise every message the
 * daemon does not report holding (`error.data.held`; no report → all).
 */
export function restoredByRefusal(
  error: unknown,
  messages: readonly { readonly id: string }[],
): readonly string[] {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === JsonRpcErrorCode.MethodNotFound || code === DomainErrorCode.NoTurnRunning) {
    return [];
  }
  const data = (error as { data?: unknown } | null)?.data;
  const held = (data as { held?: unknown } | null | undefined)?.held;
  const kept =
    Array.isArray(held) && held.every((id) => typeof id === "string")
      ? new Set<string>(held)
      : new Set<string>();
  return messages.map((m) => m.id).filter((id) => !kept.has(id));
}
