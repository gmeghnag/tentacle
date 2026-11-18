/**
 * The compose half's chat handle (13d) over the client and the SCREEN's own
 * attach handle: `attachImage`, `send`, `enqueue`, `sendNow`, `onQueued`,
 * `reclaim`, `unqueue` and 13b's outbox port — never a frame built in the app
 * (AGENTS §7 "one session path").
 *
 * Owner B4 (2026-11-15): this used to live in `App.tsx`, where the port was
 * built over an object holding only `sessionId` (`as never`), so its `facts()`
 * threw on `session.snapshot` — AFTER the compose half had cleared the field,
 * and inside a `void` call: every text send from the phone vanished. Moved here
 * so the real thing is testable against a daemon (`outbox-link.test.ts`), and
 * built over the screen's own handle: a second handle of the same id would
 * replace the client's stream listener and steal the screen's turn.
 */
import type { RemoteClient, RemoteSession } from "@tentacle/client";
import type { ComposeHandle } from "./compose-controller.ts";
import type { OutboxSession } from "./outbox-driver.ts";
import { outboxSessionOf } from "./outbox-session.ts";

export interface ComposeHandleDeps {
  readonly sessionId: string;
  readonly client: RemoteClient;
  /** The screen's OWN attach handle (a second handle of one id steals its stream). */
  readonly session: RemoteSession;
  /** A fresh turn key (a photo prompt's: a retry is free at the daemon's ledger). */
  readonly mint: () => string;
}

/**
 * 13b's driver port over the SCREEN's own handle — the ONE session path for a
 * photo message (fix/mobile-media-live item 1).
 *
 * The driver's `getSession` used to build the port from `client.newSession(...)`,
 * a SECOND `RemoteSession` for the id: `RemoteClient.register` reassigns the
 * session entry's `listener` to whichever handle opened last
 * (`remote-client.ts:3023-3026`), so the screen's `watch` received nothing. A
 * text+photo prompt then left the header on "Running" and showed no reply while
 * the daemon had finished the turn — the reply was in the history (leaving and
 * re-entering showed it), which is what made the live path look fine.
 *
 * So the port's four acts come from the handle the SCREEN holds, and only the
 * folding `prompt` is the screen's own (that is what puts the turn's events in
 * THIS transcript). A handle that is not there yet (the attach has not answered)
 * gives null: the item stays `waiting` with its key, never sent twice.
 */
export function foldingOutboxSession(
  handle: ComposeHandle | null,
  prompt: OutboxSession["prompt"],
): OutboxSession | null {
  return handle === null ? null : { ...handle.port, prompt };
}

export function composeHandleOf(deps: ComposeHandleDeps): ComposeHandle {
  const { sessionId, client, session, mint } = deps;
  return {
    sessionId,
    attachImage: (bytes, meta) => session.attachImage(bytes, meta),
    // ONE session path (AGENTS §7): the session decides upload vs laptop-extract
    // from the daemon's capability and awaits its own open — the app never does.
    attachDocument: (bytes, meta) => session.attachDocument(bytes, meta),
    send: async (text, refs) => {
      for await (const _event of session.send(text, undefined, {
        turnId: mint(),
        attachments: refs,
      })) {
        // drain: the driver needs the daemon's ack only
      }
    },
    steer: async (text, id, turnId) => {
      await client.enqueue(sessionId, id, turnId, text);
    },
    // Resolves at the ack with the successor's events: the SCREEN folds them
    // (`followSendNow`). Draining them here was why the phone never saw the
    // send-now's turn (docs/fix/mobile-queued-stuck.md (b)).
    sendNow: (messages, _turnId, next) =>
      session.sendNow(messages, "turn", next.signal, next.turnId),
    onQueued: (listener) =>
      client.onSessionQueued((notice) => {
        if (notice.sessionId === sessionId) {
          listener(notice.state);
        }
      }),
    // The queue as the client holds it now (a relaunch's snapshot lands before
    // the compose half subscribes — 13d's flow 14).
    queued: () => client.queuedOf(sessionId),
    reclaim: async (ids) => {
      await client.reclaim(sessionId, ids);
    },
    // `session/unqueue` (docs/feat/mobile-queued-compose.md D5): the client's own
    // answer, `"unsupported"` included — an older daemon is shown as such, never
    // thrown, so Edit/Cancel are hidden instead of failing.
    unqueue: (ids) => client.unqueue(sessionId, ids),
    // 13b's port over the SAME handle: `facts()` reads its snapshot and `busy`.
    port: outboxSessionOf(session, client, () => null),
  };
}
