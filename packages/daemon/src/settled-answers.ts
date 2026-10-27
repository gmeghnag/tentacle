/**
 * The answers that settled a session's recent permission requests, so a
 * `keyed` re-send of the SAME answer (the client re-sends after a link drop,
 * when the first copy may already have been acted on) is a success, not
 * `PermissionNotPending` (docs/feat/permission-reply.md, fix round 1 F1).
 *
 * Bounded: only the last `limit` answers are kept (oldest dropped first). A
 * re-send follows a drop that happened while that answer was in flight, so it
 * names one of the few most recent requests; a request older than the window
 * gets `PermissionNotPending` as before. Process memory only: a daemon restart
 * forgets it (the client then sees its session recreated, `SessionLostError`).
 */

/** One answer, as `session/resolve_permission` carried it. */
export interface SettledAnswer {
  readonly optionId: string;
  readonly message?: string;
}

/** Default window per session (each entry ≤ one reply, ≤ 2000 chars). */
export const SETTLED_ANSWERS_KEPT = 64;

export class SettledAnswers {
  private readonly answers = new Map<string, SettledAnswer>();

  constructor(private readonly limit = SETTLED_ANSWERS_KEPT) {}

  /** `answer` settled `requestId`. */
  remember(requestId: string, answer: SettledAnswer): void {
    this.answers.delete(requestId);
    this.answers.set(requestId, { optionId: answer.optionId, message: answer.message });
    while (this.answers.size > this.limit) {
      const oldest = this.answers.keys().next();
      if (oldest.done) {
        break;
      }
      this.answers.delete(oldest.value);
    }
  }

  /** `answer` is exactly the one that settled `requestId` (same option, same text). */
  isRepeat(requestId: string, answer: SettledAnswer): boolean {
    const settled = this.answers.get(requestId);
    return (
      settled !== undefined &&
      settled.optionId === answer.optionId &&
      settled.message === answer.message
    );
  }
}
