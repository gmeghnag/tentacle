/**
 * The compose half's chat handle (13d) over the client and the SCREEN's own
 * attach handle: `attachImage`, `send`, `enqueue`, `sendNow`, `onQueued`,
 * `reclaim` and 13b's outbox port — never a frame built in the app (AGENTS §7
 * "one session path").
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
import { outboxSessionOf } from "./outbox-session.ts";

export interface ComposeHandleDeps {
  readonly sessionId: string;
  readonly client: RemoteClient;
  /** The screen's OWN attach handle (a second handle of one id steals its stream). */
  readonly session: RemoteSession;
  /** A fresh turn key (a photo prompt's: a retry is free at the daemon's ledger). */
  readonly mint: () => string;
}

export function composeHandleOf(deps: ComposeHandleDeps): ComposeHandle {
  const { sessionId, client, session, mint } = deps;
  return {
    sessionId,
    attachImage: (bytes, meta) => session.attachImage(bytes, meta),
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
    sendNow: async (messages) => {
      for await (const _event of await session.sendNow(messages, "turn", undefined)) {
        // drain: the daemon's own turn runs; the screen follows it by its feed
      }
    },
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
    // 13b's port over the SAME handle: `facts()` reads its snapshot and `busy`.
    port: outboxSessionOf(session, client, () => null),
  };
}
