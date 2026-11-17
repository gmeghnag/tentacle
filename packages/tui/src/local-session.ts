/**
 * The LOCAL session a `run`/`attach`-less TUI drives from an `Agent` — i.e. the
 * session `App` builds when it is given `agent` instead of a `createSession`
 * factory (tests, and any host that holds its own `Agent`).
 *
 * It lives in a PURE module, not in the component (AGENTS §7): the adapter's
 * job is to satisfy `SessionController`'s REQUIRED members, and which of them a
 * local session can honestly answer is a decision worth reading in one place.
 *
 * Why this exists at all: `attachImage`/`imageInput`/`clear`/`sendNow` are not
 * optional on `SessionController` any more (docs/feat/remove-in-process.md —
 * their "absent" branch was the in-process fallback's). A local `Session` has no
 * image upload and no atomic send-now, so this adapter answers honestly instead
 * of silently: images are OFF with the reason a local session has, and a
 * `sendNow` is REFUSED (`MethodNotFound`) so the TUI takes its documented
 * older-daemon fallback — the same outcome the old "no `sendNow`" branch gave,
 * now a typed answer rather than a missing member.
 */
import { Session } from "@tentacle/agent";
import type { Agent } from "@tentacle/agent";
import type { SessionController } from "./app-types.ts";
import { NO_IMAGE_SEAM } from "./attach-draft.ts";
import { NO_DOCUMENT_SEAM } from "./pdf-attach.ts";

/** A local session cannot upload images: the reason the chip row shows. */
export const LOCAL_NO_IMAGES = "a local session cannot take images";

/** The same for a PDF (docs/feat/pdf-read.md D6): a local session has no daemon to read it. */
export const LOCAL_NO_DOCUMENTS = "a local session cannot read PDFs";

/**
 * `sendNow`'s refusal from a local session. `-32601` is JSON-RPC's
 * `MethodNotFound`, which is exactly what the TUI's `onSendNowError` reads as
 * "this daemon has no atomic send-now": stop the turn, then send.
 */
const METHOD_NOT_FOUND = -32601;

export function localSession(agent: Agent): SessionController {
  const inner = new Session(agent);
  return {
    send: (prompt, signal, opts) => inner.send(prompt, signal, opts),
    compact: (signal) => inner.compact(signal),
    enqueue: (text) => inner.enqueue(text),
    // In place, on the one history a local session has — which is what
    // `clearConversation` does (it keeps the session, its jobs and sub-agents).
    clear: () => Promise.resolve(inner.clearConversation()),
    // No image seam exists locally: OFF, with a reason, never a silent drop.
    imageInput: () => ({ ...NO_IMAGE_SEAM, reason: LOCAL_NO_IMAGES }),
    // Unreachable through the UI: `imageInput()` says off, so no chip is ever
    // made and this is never called. It must still exist (the member is
    // required), and it refuses rather than pretending to succeed.
    attachImage: () =>
      Promise.reject(
        new Error(`${LOCAL_NO_IMAGES} (attachImage is unreachable when imageInput() is off)`),
      ),
    // The same pair for a PDF (docs/feat/pdf-read.md D6).
    documentsInput: () => ({ ...NO_DOCUMENT_SEAM, reason: LOCAL_NO_DOCUMENTS }),
    attachDocument: () =>
      Promise.reject(
        new Error(
          `${LOCAL_NO_DOCUMENTS} (attachDocument is unreachable when documentsInput() is off)`,
        ),
      ),
    sendNow: () =>
      Promise.reject(
        Object.assign(new Error("this session has no atomic send-now"), {
          code: METHOD_NOT_FOUND,
        }),
      ),
  };
}
