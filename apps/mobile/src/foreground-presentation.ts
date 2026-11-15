/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: when a push arrives
 * while the app is FOREGROUND, `setNotificationHandler` decides whether to show
 * a banner at all (pure, so it is tested without a simulator).
 *
 * The rule: show it, unless the app is already foreground ON THAT VERY SESSION.
 * Then the sheet already holds the ask (a banner would ask twice), and a turn
 * notice is redundant. Anything else — another session, another screen, a
 * refused/unverified notification — is shown, because the person is not looking
 * at what it is about.
 *
 * Never silent: an unrecognised notification shows too. A missed ask is a stuck
 * turn (decision 8: "never a silent loss"), and the app's own dismissal logic
 * removes a banner whose ask was resolved meanwhile.
 */
import type { PushMessage } from "@tentacle/protocol";

/** The screen the app is on, as far as a banner decision goes. */
export interface CurrentScreen {
  readonly kind: "other" | "session";
  readonly computerId?: string;
  readonly sessionId?: string;
}

/**
 * Whether to present the banner. `message`: the plaintext this app opened, or
 * undefined when it could not open (then: always show — the NSE's content is the
 * only thing there is, and a verified envelope is what makes an answer possible).
 */
export function shouldPresent(message: PushMessage | undefined, screen: CurrentScreen): boolean {
  if (!message) {
    return true;
  }
  if (screen.kind !== "session") {
    return true;
  }
  // Foreground on that very session: the sheet/turn UI is what the person reads.
  return !(screen.computerId === message.computer && screen.sessionId === message.sessionId);
}

/**
 * The same rule from a notification's `userInfo`, as iOS hands it to the
 * foreground handler: only the ROUTING HINTS are read (the handler holds no keys
 * and must not decrypt), and a notification with none is shown. Display only —
 * the action path re-verifies the seal before anything is sent (Design 3), so a
 * hostile relay's hints can at most hide one banner, never make the app answer.
 */
export function presentFromHints(userInfo: unknown, screen: CurrentScreen): boolean {
  const tn =
    userInfo !== null && typeof userInfo === "object"
      ? (userInfo as { tn?: { computerId?: unknown; sessionId?: unknown } }).tn
      : undefined;
  if (tn === undefined || typeof tn !== "object") {
    return true;
  }
  const computerId = typeof tn.computerId === "string" ? tn.computerId : "";
  const sessionId = typeof tn.sessionId === "string" ? tn.sessionId : "";
  return shouldPresent(
    { v: 1, id: "", at: 0, kind: "ask", computer: computerId, cwd: "", sessionId, title: "" },
    screen,
  );
}
