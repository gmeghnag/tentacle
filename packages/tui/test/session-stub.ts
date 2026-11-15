/**
 * Test doubles for the TUI's `SessionController` (docs/feat/remove-in-process.md,
 * owner decision 2): every member it may not omit is INERT here, explicitly, so a
 * test that leaves one out cannot be mistaken for "this runtime had no such
 * member" — that fallback no longer exists in the TUI.
 *
 * Two shapes:
 * - `inertSession()` — the members every controller must now provide, as no-ops.
 *   Spread it into a literal and override what the test drives:
 *   `{ ...inertSession(), async *send() { … } }`.
 * - `agentSession(agent)` — a LOCAL agent-driven session (what `App`'s removed
 *   `agent` prop used to build), delegating to `@tentacle/agent`'s `Session` and
 *   supplying the members a local session never had.
 */
import { Session } from "@tentacle/agent";
import type { Agent } from "@tentacle/agent";
import type { SessionController } from "../src/app-types.ts";
import { NO_IMAGE_SEAM } from "../src/attach-draft.ts";

/**
 * The members a `SessionController` cannot omit, as no-ops: a test spreads this
 * into its own literal. `imageInput` answers "off" with the TUI's own reason (an
 * honest mode, not a absent seam); the two that would start a turn reject
 * loudly, because a test hitting one it did not script is a broken test.
 */
export function inertSession(): Pick<
  SessionController,
  "attachImage" | "imageInput" | "clear" | "sendNow"
> {
  return {
    attachImage: () => Promise.reject(new Error("attachImage: not scripted by this test")),
    imageInput: () => NO_IMAGE_SEAM,
    clear: () => Promise.resolve({ before: 0, after: 0 }),
    sendNow: () => Promise.reject(new Error("sendNow: not scripted by this test")),
  };
}

/**
 * A local agent's session as a controller (the shape `App`'s `agent` prop built
 * before it was removed): `@tentacle/agent`'s `Session` for the conversation,
 * `/clear` resetting it in place (`clearConversation`, what a local reset is),
 * and the image/send-now seams a local session never had, refused.
 */
export function agentSession(agent: Agent): SessionController {
  const inner = new Session(agent);
  return {
    ...inertSession(),
    send: (prompt, signal, opts) =>
      inner.send(prompt, signal, opts as Parameters<Session["send"]>[2]),
    compact: (signal) => inner.compact(signal),
    enqueue: (text) => inner.enqueue(text),
    clear: () => Promise.resolve(inner.clearConversation()),
  };
}
