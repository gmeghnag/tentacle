/**
 * The driver's session port, for real (docs/feat/mobile-compose.md 13b, D4):
 * built from the session the controller opened plus the client that owns it, so
 * every act goes through the client's own method — no frame is built here
 * (AGENTS §7 "one session path").
 *
 * It exists because `steer` must be TURN-BOUND and `RemoteSession` has no such
 * method: its `enqueue(text, id?)` binds to whatever turn the client believes
 * runs, and RESOLVES WITHOUT SENDING when it sees none
 * (`remote-session.ts:958-963`). A port that took it (its two parameters are
 * assignable to this three-parameter shape, so the compiler would not object)
 * would turn a steer whose turn just ended into a silent drop — or into a steer
 * of the NEXT turn. So the steer goes to `RemoteClient.enqueue(sessionId, id,
 * turnId, text)` (`remote-client.ts:2090`), which the daemon checks against
 * `activeTurnId` and refuses `NoTurnRunning` for a stale one
 * (`hosted-session.ts:2700-2720`) — a refusal this app can see, not a void.
 */
import type { RemoteClient, RemoteSession } from "@tentacle/client";
import type { OutboxSession } from "./outbox-driver.ts";
import type { SessionFacts } from "./outbox.ts";

/**
 * The session handle is not open yet (no id): the act cannot be addressed.
 * Named so `refusalOf` reads it as "no answer from the daemon" and the item
 * stays `waiting` instead of being finished or dropped.
 */
export class SessionNotOpenError extends Error {
  constructor() {
    super("the session is not open");
    this.name = "SessionNotOpenError";
  }
}

/**
 * The port for an OPENED session.
 *
 * `runningTurn` is the turn the app is watching (`SessionActivity{kind:"turn"}`,
 * 13d's `session-view.ts`): it is null when no turn runs, so a stale one cannot
 * be named here. `facts` reads the daemon's own state (the snapshot's length,
 * whether a turn runs) — the same values after an app kill, which is what makes
 * `decide`'s basis comparable.
 */
export function outboxSessionOf(
  session: RemoteSession,
  client: RemoteClient,
  runningTurn: () => string | null,
): OutboxSession {
  return {
    upload: (bytes, meta) => session.attachImage(bytes, meta),
    prompt: async (text, turnId, attachments) => {
      for await (const _event of session.send(text, undefined, { turnId, attachments })) {
        // drain: the daemon's ack is all the driver needs
      }
    },
    steer: (text, id, turnId) => {
      const sessionId = session.sessionId;
      if (sessionId === null) {
        throw new SessionNotOpenError();
      }
      return client.enqueue(sessionId, id, turnId, text);
    },
    facts: async () => {
      const snapshot = (await session.snapshot()) ?? [];
      return {
        availability: "open",
        historyLength: snapshot.length,
        runningTurnId: session.busy ? runningTurn() : null,
      };
    },
  };
}

/**
 * The port for a session that could not be opened (archived, deleted, gone, or
 * no answer): its acts cannot run, but its FACTS carry the reason, so `decide`
 * puts the item back in the field (F20 — and never reopens it).
 */
export function unavailableSessionPort(
  availability: Exclude<SessionFacts["availability"], "open">,
): OutboxSession {
  const refuse = (): never => {
    throw new SessionNotOpenError();
  };
  return {
    upload: refuse,
    prompt: refuse,
    steer: refuse,
    facts: () => Promise.resolve({ availability, historyLength: 0, runningTurnId: null }),
  };
}
