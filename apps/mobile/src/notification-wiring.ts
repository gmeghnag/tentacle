import type { AuthResult } from "./app-lock.ts";
import type { PinnedComputer, PushKeyMaterial, SeenAnswers } from "./notification-action.ts";
/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: the app-side BINDING of
 * the notification path — the runtime's real objects (the link registry, the
 * computer store, the lock, navigation) plugged into the pure dispatcher
 * (`notification-dispatch.ts`) and the thin expo adapter
 * (`notifications-expo.ts`).
 *
 * It is one object so the wiring exists in ONE place (AGENTS §7: components
 * render, this decides; `App.tsx` only calls `start()` and `stop()`).
 */
import type { AnswerDeps, AnswerLink, FallbackNotice } from "./notification-answer.ts";
import { type AnswerAction, NotificationAnswerer, answerDecision } from "./notification-answer.ts";
import type { DispatchOutcome, NotificationDispatchDeps } from "./notification-dispatch.ts";
import { dispatchNotification } from "./notification-dispatch.ts";
import {
  drainColdStartResponse,
  onNotificationResponse,
  registerCategories,
  scheduleFallbackNotice,
} from "./notifications-expo.ts";
import type { SessionRoute } from "./routes.ts";

/** The link surface the notification path takes from the app's registry. */
export type NotificationLink = AnswerLink;

/** Everything the wiring needs from `App.tsx` — all already built there. */
export interface NotificationWiring {
  /** The registry's ONE link for a computer (`LINKS.get`), never a new dial. */
  readonly link: (computerId: string) => Promise<NotificationLink>;
  /** The paired computers, public halves only. */
  readonly computers: () => Promise<readonly PinnedComputer[]>;
  /** This phone's push keys (current, then ≤ 24 h retired ones). */
  readonly pushKeys: () => Promise<readonly PushKeyMaterial[]>;
  /** The asks already answered from here. */
  readonly answered: SeenAnswers;
  /** Face ID / passcode with the notification's own sentence. */
  readonly authenticate: (prompt: string) => Promise<AuthResult>;
  /** One Face ID success also clears the app lock (Owner Q2). */
  readonly unlockApp: () => void;
  /** Whether the app is foreground (a background action holds the gate). */
  readonly inForeground: () => boolean;
  /** The computer's display name, for the fallback's sentence. */
  readonly computerName: (computerId: string) => string;
  /** Where Open lands (a session, or the computers list). */
  readonly navigate: (route: SessionRoute | "computers") => void;
  /** Say why an action was refused, once (Design 3). */
  readonly refuse: (
    why: "unverified" | "expired" | "no-option" | "empty-reply" | "answered",
  ) => void;
  /** One `app-log` line (kind + ids, never text). */
  readonly log: (line: string) => void;
  /** The app's own outcome notice (only meaningful in the foreground). */
  readonly notice: (notice: { kind: string; text: string }) => void;
  /** The archived flag of a session the app knows (F20). */
  readonly archived?: (computerId: string, sessionId: string) => boolean;
  /** The store's title, when the plaintext's is empty. */
  readonly title?: (computerId: string, sessionId: string) => string | undefined;
  /** A background action's budget (N0(d)). */
  readonly budgetMs?: number;
  /** The clock (ms). */
  readonly now?: () => number;
}

/** The started wiring: `handle` is what the expo listener and the cold drain call. */
export interface StartedNotifications {
  handle(response: {
    actionId: string;
    userInfo: unknown;
    userText?: string;
  }): Promise<DispatchOutcome>;
  stop(): void;
}

/**
 * Build the dispatcher from the app's objects, register the categories, listen
 * for responses and drain the one that launched the app. Returns the handle the
 * app also uses for a test hook (`e2e`'s `notify-respond`), plus `stop`.
 */
export async function startNotifications(
  wiring: NotificationWiring,
): Promise<StartedNotifications> {
  const answerDeps: AnswerDeps = {
    links: {
      // The registry's ONE link, with ITS gate: a background answer holds the
      // same gate the app's own suspend/resume drives (AGENTS §7, one session path).
      get: (computerId) => wiring.link(computerId).catch(() => undefined),
    },
    authenticate: (prompt) => wiring.authenticate(prompt),
    unlockApp: () => wiring.unlockApp(),
    scheduleFallback: (notice: FallbackNotice, ms) => {
      // A local notification is scheduled asynchronously; the canceller is
      // synchronous for the caller (`notification-answer.ts`), so a cancel before
      // the schedule lands cancels nothing — it is a no-op, and the notice fires.
      let cancel: (() => void) | undefined;
      let cancelled = false;
      void scheduleFallbackNotice(notice, ms).then((fn) => {
        if (cancelled) {
          fn();
        } else {
          cancel = fn;
        }
      });
      return () => {
        cancelled = true;
        cancel?.();
      };
    },
    log: (line) => wiring.log(line),
    notice: (notice) => wiring.notice(notice),
    openSession: (route) => wiring.navigate(route),
    inForeground: () => wiring.inForeground(),
    computerName: (computerId) => wiring.computerName(computerId),
    ...(wiring.budgetMs !== undefined ? { budgetMs: wiring.budgetMs } : {}),
  };
  const answerer = new NotificationAnswerer(answerDeps);
  const dispatchDeps: NotificationDispatchDeps = {
    computers: () => wiring.computers(),
    pushKeys: () => wiring.pushKeys(),
    answered: wiring.answered,
    now: () => wiring.now?.() ?? Date.now(),
    answer: answerDeps,
    route: (opened) =>
      opened === undefined
        ? "computers"
        : {
            computerId: opened.computer.id,
            sessionId: opened.message.sessionId,
            title:
              opened.message.title ||
              wiring.title?.(opened.computer.id, opened.message.sessionId) ||
              "",
            archived: wiring.archived?.(opened.computer.id, opened.message.sessionId) === true,
          },
    navigate: (route) => wiring.navigate(route),
    refuse: (why) => wiring.refuse(why),
    unlockApp: () => wiring.unlockApp(),
  };

  await registerCategories();
  const handle = (response: {
    actionId: string;
    userInfo: unknown;
    userText?: string;
  }): Promise<DispatchOutcome> => dispatchNotification(response, dispatchDeps, answerer);
  const unsubscribe = onNotificationResponse((response) => {
    void handle(response).catch(() => undefined);
  });
  // The response that LAUNCHED the app (F12): a cold start from an action must
  // not be lost — the listener above only sees later ones.
  void drainColdStartResponse()
    .then((response) => {
      if (response) {
        void handle(response).catch(() => undefined);
      }
    })
    .catch(() => undefined);
  return {
    handle,
    stop: () => {
      unsubscribe();
    },
  };
}
