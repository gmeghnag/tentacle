/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: what the app DOES with
 * one notification response, as one pure dispatcher over the already-tested
 * pieces. `notifications-expo.ts` only converts expo's shapes and calls this, so
 * the whole route (open → navigate; answer → authenticate → hold → dial →
 * answer) is understood in one place and tested without a simulator.
 *
 * Nothing here trusts the notification: the plaintext is re-opened
 * (`notification-action.ts` `openNotification`) with this phone's keys and the
 * pinned computer key, and every id used comes from it.
 */
import type { NotificationAnswerOutcome } from "@tentacle/client";
import type { PushMessage } from "@tentacle/protocol";
import { decodeBase64Url } from "@tentacle/protocol";
import {
  type ActionDecision,
  type PinnedComputer,
  type PushKeyMaterial,
  type SeenAnswers,
  decideAction,
} from "./notification-action.ts";
import type { AnswerAction, AnswerDeps, AnswerOutcome } from "./notification-answer.ts";
import { NotificationAnswerer } from "./notification-answer.ts";
import type { SessionRoute } from "./routes.ts";

/** What the dispatcher may use, injected. */
export interface NotificationDispatchDeps {
  /** This phone's paired computers (id + pinned key). */
  readonly computers: () => Promise<readonly PinnedComputer[]>;
  /** This phone's push private keys (current, then ≤ 24 h retired). */
  readonly pushKeys: () => Promise<readonly PushKeyMaterial[]>;
  /** The asks already answered from here (`notification-action.ts` `SeenAnswers`). */
  readonly answered: SeenAnswers;
  readonly now: () => number;
  /** The answer sequence's own deps (link, gate, Face ID, fallback, notices). */
  readonly answer: AnswerDeps;
  /** Where Open lands (`notification-route.ts`). */
  readonly route: (
    opened:
      | { readonly computer: { readonly id: string }; readonly message: PushMessage }
      | undefined,
  ) => SessionRoute | "computers";
  readonly navigate: (route: SessionRoute | "computers") => void;
  /**
   * Say why an action was refused (Design 3: "This notification could not be
   * verified"). One line, never the notification's text.
   */
  readonly refuse?: (
    why: "unverified" | "expired" | "no-option" | "empty-reply" | "answered",
  ) => void;
  /** The app lock's "this Face ID success also clears the lock" hook. */
  readonly unlockApp?: () => void;
}

/** What a dispatch came to (display/tests). */
export type DispatchOutcome =
  | { readonly kind: "navigated"; readonly route: SessionRoute | "computers" }
  | { readonly kind: "answered"; readonly outcome: AnswerOutcome }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "ignored" };

/**
 * Handle one response. `actionId`: the tapped action (`notification-categories.ts`
 * ids, or `default` for a plain tap), `userInfo`: the notification's payload.
 */
export async function dispatchNotification(
  response: { readonly actionId: string; readonly userInfo: unknown; readonly userText?: string },
  deps: NotificationDispatchDeps,
  answerer: NotificationAnswerer = new NotificationAnswerer(deps.answer),
): Promise<DispatchOutcome> {
  const [computers, pushKeys] = await Promise.all([deps.computers(), deps.pushKeys()]);
  const decision: ActionDecision = decideAction({
    userInfo: response.userInfo,
    actionId: response.actionId,
    ...(response.userText !== undefined ? { userText: response.userText } : {}),
    computers,
    pushKeys,
    answered: deps.answered,
    now: deps.now(),
  });

  if (decision.do === "refuse") {
    deps.refuse?.(decision.why);
    // A tap on a notification that cannot be verified still OPENS the app: the
    // person must land somewhere sensible, with the list in front of them.
    if (response.actionId === "default" || response.actionId === "tentacle.open") {
      deps.navigate("computers");
      return { kind: "navigated", route: "computers" };
    }
    return { kind: "refused", why: decision.why };
  }

  if (decision.do === "open") {
    deps.navigate(decision.route);
    return { kind: "navigated", route: decision.route };
  }

  // An ANSWER. The answered-set records the attempt BEFORE the send, so a
  // duplicate tap during the run is refused here and the daemon's own
  // first-wins is the second net (F18).
  deps.answered.add(decision.computerId, decision.requestId);
  const outcome = await answerer.run(decision as AnswerAction);
  return { kind: "answered", outcome };
}

/**
 * The "answered" bookkeeping item: ids the app has already tried to answer, so a
 * duplicated notification cannot answer twice (`notification-access.ts` in the
 * real app keeps it in the shared Keychain next to the NSE's seen-set).
 */
export class MemoryAnswers implements SeenAnswers {
  private readonly ids = new Set<string>();
  has(computerId: string, requestId: string): boolean {
    return this.ids.has(`${computerId}\u0000${requestId}`);
  }
  add(computerId: string, requestId: string): void {
    this.ids.add(`${computerId}\u0000${requestId}`);
  }
}

/** Re-exported so the app has ONE name for "an answer came to this". */
export type { NotificationAnswerOutcome, AnswerAction };

/** base64url decode, re-exported for the wiring's key material. */
export { decodeBase64Url };
