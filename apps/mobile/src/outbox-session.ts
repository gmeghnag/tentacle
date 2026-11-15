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
 * The act could not be addressed to a live session: there is no id to name, or
 * the session is archived / deleted / gone. An act that never reached the wire
 * is NOT a refusal to show as one — `refusalOf` reads this as "no answer from
 * the daemon" (the item stays `waiting`, F1) or, when the error names an
 * unopenable state, as the draft it belongs in (F20). `RemoteSession` throwing
 * a bare `Error` here would read as `decide/refused`, which shows a link drop
 * as the daemon's refusal.
 */
export class SessionNotOpenError extends Error {
  /**
   * Which session state the act ran into: `"link"` for a session that could not
   * be opened, and the reason itself for one the daemon says is gone. The
   * offline port serves both, so the error has to say which (`refusalOf`).
   */
  readonly availability: Exclude<SessionFacts["availability"], "open">;

  constructor(availability: Exclude<SessionFacts["availability"], "open"> = "link") {
    super(`the session is not open (${availability})`);
    this.name = "SessionNotOpenError";
    this.availability = availability;
  }
}

/**
 * An own prompt whose CALLER is done at the daemon's ack, while its turn keeps
 * streaming into `consume` (docs/fix/mobile-chat-glitches.md, bug 2). The
 * outbox item must leave at the ack — the daemon then holds its key, so F3
 * holds — not at the turn's end, which a model thinking for minutes (or a turn
 * waiting on an ask) puts arbitrarily far away.
 *
 * `start(onAccepted)` opens the stream; the client calls `onAccepted` at the
 * ack. The stream's first event counts too (the old proxy, kept as a fallback:
 * an event of our own turn means the daemon took it). `accepted`:
 * - resolves at the first of those two;
 * - rejects with the stream's error if it failed before either (a refusal: the
 *   words go back, F7);
 * - rejects `SessionNotOpenError("link")` if the stream ENDED before either —
 *   no answer is not a send: the item stays `waiting` with its key, and the
 *   reconnect asks the daemon (`decide`).
 * An error after acceptance is the turn's (the transcript folds it as LOST).
 * `done` settles once `consume` finished (never rejects).
 */
export function untilAccepted<T>(
  start: (onAccepted: () => void) => AsyncIterable<T>,
  consume: (events: AsyncIterable<T>, accepted: Promise<void>) => Promise<void>,
): { readonly accepted: Promise<void>; readonly done: Promise<void> } {
  let took = false;
  let failure: unknown;
  let markTook: () => void = () => {};
  const tookSignal = new Promise<void>((resolve) => {
    markTook = resolve;
  });
  const onAccepted = (): void => {
    if (!took) {
      took = true;
      markTook();
    }
  };
  const events = (async function* guarded(): AsyncIterable<T> {
    try {
      for await (const event of start(onAccepted)) {
        onAccepted();
        yield event;
      }
    } catch (error) {
      failure = error;
      throw error;
    }
  })();
  const done = consume(events, tookSignal).catch(() => {
    // The stream's error: `failure` carries it to `accepted` below.
  });
  const accepted = new Promise<void>((resolve, reject) => {
    void tookSignal.then(resolve);
    void done.then(() => {
      if (!took) {
        reject(failure ?? new SessionNotOpenError("link"));
      }
    });
  });
  return { accepted, done };
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
    // Done at the daemon's ack; the turn keeps draining detached (no screen folds it).
    prompt: (text, turnId, attachments) =>
      untilAccepted(
        (onAccepted) => session.send(text, undefined, { turnId, attachments, onAccepted }),
        async (events) => {
          for await (const _event of events) {
            // drain: the daemon's ack is all the driver needs
          }
        },
      ).accepted,
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
    throw new SessionNotOpenError(availability);
  };
  return {
    upload: refuse,
    prompt: refuse,
    steer: refuse,
    facts: () => Promise.resolve({ availability, historyLength: 0, runningTurnId: null }),
  };
}
