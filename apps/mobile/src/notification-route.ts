/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: where an Open tap
 * LANDS, as a pure decision (`notification-route.ts`).
 *
 * The rule that matters: the route comes from the plaintext THIS app opened
 * (`openNotification`), never from `userInfo.tn`. A notification whose envelope
 * does not open navigates to the computers list — never to a session id a
 * hostile relay typed into `userInfo` (Design 3, F5). A computer that is no
 * longer paired also lands on the list (F9): there is nothing to open on it.
 */
import type { SessionRoute } from "./routes.ts";

/** What the app knows about its paired computers (injected: the store/rows). */
export interface KnownComputers {
  has(computerId: string): boolean;
  /** The session's title, from the store/list when the plaintext's is empty. */
  title?(computerId: string, sessionId: string): string | undefined;
  /** Whether the session is known to be archived (the screen's banner). */
  archived?(computerId: string, sessionId: string): boolean;
}

/**
 * An Open tap's destination. `computers` means "the list", which is also where
 * an unverifiable notification lands (it says why — Design 3).
 */
export function notificationRoute(
  opened:
    | {
        readonly computer: { readonly id: string };
        readonly message: {
          readonly sessionId: string;
          readonly title: string;
        };
      }
    | undefined,
  known: KnownComputers,
): SessionRoute | "computers" {
  if (!opened) {
    return "computers";
  }
  const computerId = opened.computer.id;
  if (!known.has(computerId)) {
    // Paired then removed (F9): never open a session on a computer this phone no
    // longer holds the key for.
    return "computers";
  }
  const title = opened.message.title || known.title?.(computerId, opened.message.sessionId) || "";
  return {
    computerId,
    sessionId: opened.message.sessionId,
    title,
    archived: known.archived?.(computerId, opened.message.sessionId) === true,
  };
}
