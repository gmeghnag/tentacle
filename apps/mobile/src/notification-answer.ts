/**
 * docs/feat/mobile-notifications.md Design 4 / slice N6: the coordinator that
 * actually SENDS an answer a notification decided on — pure, with every effect
 * injected, so the whole sequence is tested without a phone.
 *
 * The rules, each a failure mode in the plan:
 *  1. **Approve asks Face ID ALWAYS** (decision 14), even when the app is
 *     unlocked: a lock-screen gesture is not approval of a command. A
 *     cancel/fail sends nothing and leaves the sheet on screen (F15).
 *  2. **The fallback notification is scheduled BEFORE dialling** (F13): if iOS
 *     suspends the app first, the person still sees "couldn't reach — tap to
 *     answer". It is cancelled on `sent` / `not-pending`.
 *  3. **A background action holds the gate** for its budget and always releases
 *     it, on every outcome.
 *  4. **Never detach what it did not attach** (F19).
 *  5. **Never retried on its own** (Owner Q4): a failure is reported once, and the
 *     ask stays pending daemon-side for the sheet.
 *  6. In-flight join per `requestId` (F18) lives in `NotificationAnswerer`.
 */
import type { NotificationAnswerOutcome } from "@tentacle/client";
import type { AuthResult } from "./app-lock.ts";
import type { ActionDecision } from "./notification-action.ts";
import type { SessionRoute } from "./routes.ts";

/** The answer path's client surface (a `RemoteClient`, injected). */
export interface AnswerClient {
  isAttached(sessionId: string): boolean;
  attachSession(sessionId: string, listener: unknown): Promise<string>;
  detachSession(sessionId: string): Promise<void>;
  answerPermission(
    sessionId: string,
    requestId: string,
    response: { allowed: boolean; scope?: "once" | "session"; message?: string },
  ): Promise<NotificationAnswerOutcome>;
}

/** A computer's ONE link, as the answer path needs it. */
export interface AnswerLink {
  readonly client: AnswerClient;
  /**
   * The computer's own foreground gate (`connection.ts` `ComputerLink.hold`).
   * It comes WITH the link on purpose: there is one gate per link (AGENTS §7
   * "one session path"), and a hold taken on any other gate would let a
   * background answer dial around the one the app drives.
   */
  hold(ms: number): () => void;
}

/** What the coordinator needs from the app, all injected. */
export interface AnswerDeps {
  /** The computer's ONE link (`link-registry.ts`), or nothing when it cannot be dialled. */
  readonly links: { get(computerId: string): Promise<AnswerLink | undefined> };
  /** Face ID / passcode (decision 14), the lock's own vocabulary. */
  readonly authenticate: (prompt: string) => Promise<AuthResult>;
  /** One Face ID success also clears the app lock (Owner Q2: one prompt, not two). */
  readonly unlockApp?: () => void;
  /** Schedule the fallback local notification; returns its canceller. */
  readonly scheduleFallback: (notice: FallbackNotice, ms: number) => () => void;
  /** One `app-log` line: kind + outcome, never text (F23). */
  readonly log?: (line: string) => void;
  /** A visible outcome, foreground only (there is nobody to read one in the background). */
  readonly notice?: (notice: AppNotice) => void;
  /** Navigate to the session (its sheet shows the still-pending ask). */
  readonly openSession?: (route: SessionRoute) => void;
  /** Is the app in the foreground now? */
  readonly inForeground: () => boolean;
  /** A background action's iOS budget (N0(d); clamped to ≤ 25 s). */
  readonly budgetMs?: number;
  /** The computer's display name, for the fallback's sentence. */
  readonly computerName: (computerId: string) => string;
}

/** The local notification scheduled before a dial, cancelled when the answer lands. */
export interface FallbackNotice {
  readonly computerId: string;
  readonly sessionId: string;
  /** The session's title for the route (the plaintext's, never a relay's). */
  readonly title: string;
  /** "Couldn't reach <computer> — tap to answer". */
  readonly text: string;
  /** A reply's words, put back into the sheet's field (`drafts.ts`) on a tap. */
  readonly draft?: string;
}

/** What the person is told after an answer attempt (Design 4 step 5). */
export interface AppNotice {
  readonly kind: "approved" | "denied" | "replied" | "answered-elsewhere" | "unreachable";
  readonly text: string;
}

/** The default budget (Design 4 step 2; N0(d) may lower it, never above 25 s). */
export const ANSWER_BUDGET_MS = 20_000;
/** The hard ceiling the plan sets (Owner Q4). */
export const ANSWER_BUDGET_MAX_MS = 25_000;

/** The sentence Face ID shows for an approval from a notification (decision 14). */
export function approvePrompt(what: string): string {
  return `Approve ${what}?`;
}

/** What one answer attempt came to, as the caller (and the log) sees it. */
export type AnswerOutcomeKind =
  | "sent"
  | "not-pending"
  | "unreachable"
  | "unknown-session"
  | "failed"
  | "session-lost"
  | "auth-cancelled"
  | "auth-failed";

export interface AnswerOutcome {
  readonly kind: AnswerOutcomeKind;
}

/** 8 characters of an id, for a log line that must never carry text (F23). */
function short(id: string): string {
  return id.slice(0, 8);
}

/** The action kinds that send something (`open`/`refuse` never reach here). */
export type AnswerAction = Extract<ActionDecision, { do: "approve" | "deny" | "reply" }>;

/**
 * Run one decided action. The order below is the plan's Design 4 steps, and each
 * one exists because of a failure mode named in the comment.
 */
export async function answerDecision(
  decision: AnswerAction,
  deps: AnswerDeps,
): Promise<AnswerOutcome> {
  const budget = Math.min(deps.budgetMs ?? ANSWER_BUDGET_MS, ANSWER_BUDGET_MAX_MS);
  const { computerId, sessionId, requestId, response } = decision;
  const kind = decision.do;
  const foreground = deps.inForeground();
  const label = kind === "reply" ? (response.message ?? "") : "";

  // 1. Approve ALWAYS asks (decision 14), whether or not the app is unlocked:
  //    mutation — skip when unlocked — a lock-screen tap would approve a command.
  if (kind === "approve") {
    const auth = await deps.authenticate(approvePrompt(decision.do));
    if (auth !== "success") {
      deps.log?.(`notify auth ${short(requestId)} ${auth}`);
      // Nothing is sent; the person lands on the session whose sheet still holds
      // the ask (Design 4 step 1).
      deps.openSession?.({ computerId, sessionId, title: "", archived: false });
      return { kind: auth === "cancel" ? "auth-cancelled" : "auth-failed" };
    }
    // One success clears the app lock too (Owner Q2: one prompt, not two).
    deps.unlockApp?.();
  }

  // 2. The fallback is scheduled BEFORE the dial (F13) — if iOS suspends us mid
  //    answer, it still fires.
  const fallback = foreground
    ? () => {}
    : deps.scheduleFallback(
        {
          computerId,
          sessionId,
          title: "",
          text: `Couldn't reach ${deps.computerName(computerId)} — tap to answer`,
          ...(label !== "" ? { draft: label } : {}),
        },
        budget,
      );

  let attached = false;
  let link: AnswerLink | undefined;
  // 3. A background action holds the LINK's gate for its budget, and the release
  //    runs on EVERY path (the `finally` below). The gate comes with the link:
  //    there is one per link, so a background answer can never dial around it.
  const release = (): void => {
    held?.();
  };
  let held: (() => void) | undefined;
  let outcome: AnswerOutcomeKind;
  try {
    link = await deps.links.get(computerId);
    if (link && !foreground) {
      held = link.hold(budget);
    }
    if (!link) {
      // F1/F3/F10: no dial at all. The scheduled fallback covers the background.
      outcome = "unreachable";
    } else {
      if (!link.client.isAttached(sessionId)) {
        await link.client.attachSession(sessionId, {});
        attached = true;
      }
      const answer = await link.client.answerPermission(sessionId, requestId, response);
      switch (answer) {
        case "sent":
          outcome = "sent";
          break;
        case "not-pending":
          // Another answer won: expected, not an error (F17).
          outcome = "not-pending";
          break;
        case "session-lost":
          // F2: it MAY have arrived. Never phrased as success.
          outcome = "session-lost";
          break;
        case "unoffered":
        case "unreplyable":
          // The daemon refused the answer's SHAPE: nothing was decided, so the
          // sheet is the only honest place to finish.
          outcome = "failed";
          break;
        default:
          // `failed`: not delivered. The fallback fires; never retried on its own.
          outcome = "failed";
      }
    }
  } catch (error) {
    outcome = attachFailure(error);
  } finally {
    // 4. Detach only what this run attached (F19: never the screen's).
    if (attached && link) {
      try {
        await link.client.detachSession(sessionId);
      } catch {
        // A failed detach is the daemon's idle reap: nothing to report.
      }
    }
    release();
  }

  // A confirmed answer cancels the fallback; every other outcome lets it stand.
  if (outcome === "sent" || outcome === "not-pending") {
    fallback();
    if (foreground && deps.notice) {
      deps.notice(outcome === "not-pending" ? answeredElsewhere() : sentNotice(kind));
    }
  } else {
    deps.log?.(`notify outcome ${short(requestId)} ${outcome}`);
    if (foreground && outcome === "session-lost" && deps.notice) {
      deps.notice({ kind: "unreachable", text: "May not have been sent — open the session" });
    }
    if (outcome === "failed") {
      deps.openSession?.({ computerId, sessionId, title: "", archived: false });
    }
  }
  deps.log?.(`notify answer ${short(requestId)} ${outcome}`);
  return { kind: outcome };
}

/** `attachSession`'s two refusal kinds are not "unreachable" (F20). */
function attachFailure(error: unknown): AnswerOutcomeKind {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/UnknownSession|archived|deleted/i.test(`${name} ${message}`)) {
    return "unknown-session";
  }
  return "unreachable";
}

/** The notice for a confirmed answer (Design 4 step 5). */
function sentNotice(kind: AnswerAction["do"]): AppNotice {
  if (kind === "approve") {
    return { kind: "approved", text: "Approved" };
  }
  if (kind === "deny") {
    return { kind: "denied", text: "Denied" };
  }
  return { kind: "replied", text: "Replied" };
}

function answeredElsewhere(): AppNotice {
  return { kind: "answered-elsewhere", text: "Already answered" };
}

/**
 * The in-flight join (F18) and the answered-set bookkeeping around
 * `answerDecision`: a second tap for the same `requestId` while one answer runs
 * joins it, so a duplicate delivery cannot send twice.
 */
export class NotificationAnswerer {
  private readonly inFlight = new Map<string, Promise<AnswerOutcome>>();
  constructor(private readonly deps: AnswerDeps) {}

  run(decision: AnswerAction): Promise<AnswerOutcome> {
    const key = `${decision.computerId}\u0000${decision.requestId}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const run = answerDecision(decision, this.deps).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** Whether an answer for this request is running right now (display/tests). */
  isRunning(computerId: string, requestId: string): boolean {
    return this.inFlight.has(`${computerId}\u0000${requestId}`);
  }
}
