/**
 * docs/feat/mobile-notifications.md Design 1 / slice N2: what the phone SHOWS
 * for a push, as pure data. `render(msg, peer, now) → Rendered` decides the
 * banner's words, its category (the actions it may offer), its interruption
 * level and its thread — and the Swift Notification Service Extension mirrors
 * this file byte for byte, pinned by shared vector files
 * (`apps/mobile/test/fixtures/push-render-v1.json` for both, plus this module's
 * own assertions). One spec, two implementations, no drift (decision 20).
 *
 * Rules that are security-relevant, not cosmetic:
 *  - **Approve is only ever `allow_once`.** A lasting rule ("allow always")
 *    needs the in-app sheet, where the person sees the full request; a
 *    notification offers the narrowest approval only (decision 8).
 *  - **Anything unrenderable is the PLACEHOLDER**: no category, no added
 *    `userInfo`, so a hostile relay's `aps` (its text, its category) is never
 *    dressed up with actions of ours. The NSE always overwrites
 *    `categoryIdentifier`; this module is what it overwrites it WITH.
 *  - `userInfo.tn` (the routing hints: `{v, kind, computerId, sessionId,
 *    requestId?}`) is for Open and for dismissal, never for an answer — the
 *    answer path re-opens the seal (Design 3).
 *  - Display only, and every string came from a daemon that may be a pod: no
 *    ANSI, no control characters, bounded (the plaintext is already clipped by
 *    `fitPushMessage`; this is the second belt).
 */
import type { PushAsk, PushMessage } from "@tentacle/protocol";
import { stripAnsi } from "./ansi.ts";

/** The category ids the app registers at every start (`notification-categories.ts`). */
export const CATEGORY_ASK = "tentacle.ask";
export const CATEGORY_ASK_REPLY = "tentacle.ask.reply";
export const CATEGORY_OPEN = "tentacle.open";

/** Every category this build knows; the placeholder adds none of them. */
export type NotificationCategory =
  | typeof CATEGORY_ASK
  | typeof CATEGORY_ASK_REPLY
  | typeof CATEGORY_OPEN
  | "";

/** iOS's `UNNotificationInterruptionLevel`, as this module names it. */
export type InterruptionLevel = "passive" | "active" | "timeSensitive";

/** The plaintext's OWN version this build renders; a future one is a placeholder (F11). */
const RENDER_VERSION = 1;

/**
 * The routing hints in `userInfo.tn`: enough for Open to land on the session
 * (and for a dismissal to match an ask), never enough to answer anything.
 */
export interface NotificationHints {
  readonly v: 1;
  readonly kind: PushMessage["kind"];
  readonly computerId: string;
  readonly sessionId: string;
  readonly requestId?: string;
}

/** What the NSE sets on the notification's content, plus the routing hints. */
export interface Rendered {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly category: NotificationCategory;
  readonly interruptionLevel: InterruptionLevel;
  /** Whether the banner makes a sound. */
  readonly sound: boolean;
  /** Grouping per session (`s:<sessionId>`), so turns fold under their session. */
  readonly threadIdentifier: string;
  /** The hints to put in `userInfo.tn`; ABSENT on the placeholder (which adds nothing). */
  readonly hints?: NotificationHints;
  /** True for the unrenderable fallback: the relay's own `aps` text is shown instead. */
  readonly placeholder: boolean;
}

/** What the relay's outer `aps` says when nothing could be rendered (task 16 P4). */
export const PLACEHOLDER_TEXT = "Open tentacle to see what's new";

/** The placeholder: no category (no actions), nothing added to `userInfo`, quiet. */
export function placeholder(): Rendered {
  return {
    title: "",
    body: PLACEHOLDER_TEXT,
    category: "",
    interruptionLevel: "active",
    sound: false,
    threadIdentifier: "",
    placeholder: true,
  };
}

/** The one text rule: ANSI stripped, control characters dropped, trimmed (display only). */
function clean(text: string): string {
  return stripAnsi(text)
    .split("")
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      // Tab and newline are fine (trimmed, or shown as a space); drop the rest.
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("")
    .trim();
}

/** `basename(cwd)`: the project, as the banner names it (`/home/me/repo` → `repo`). */
export function projectName(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p !== "");
  return parts.at(-1) ?? cwd;
}

/**
 * The category an ask gets, from the kinds the daemon OFFERED: Reply only when
 * both a refusal and a reply are on offer, Approve only when an `allow_once` is
 * (never `allow_always`: a lasting rule needs the sheet), Deny only with a
 * `reject_once`. No approval offered at all → `tentacle.open`, a plain Open
 * (a relay cannot invent an action we do not have).
 */
export function categoryFor(ask: PushAsk): NotificationCategory {
  const kinds = new Set(ask.options.map((o) => o.kind));
  if (!kinds.has("allow_once")) {
    return CATEGORY_OPEN;
  }
  if (!kinds.has("reject_once")) {
    return CATEGORY_OPEN;
  }
  return ask.reply !== undefined ? CATEGORY_ASK_REPLY : CATEGORY_ASK;
}

/** The peer a push came from, as far as display goes (the name the person gave). */
export interface RenderPeer {
  readonly computerName: string;
}

/**
 * Render one opened plaintext. `now` (ms) is the phone's clock, used only for
 * the age guard the NSE also applies (`at` older than 24 h, or further than
 * 10 min in the future, is not rendered — F7); an unrenderable message is the
 * placeholder, never a half-built banner.
 */
export function render(msg: PushMessage, peer: RenderPeer, now: number): Rendered {
  if (msg.v !== RENDER_VERSION) {
    return placeholder();
  }
  const computer = clean(peer.computerName);
  const project = projectName(clean(msg.cwd));
  const title = clean(msg.title);
  const threadIdentifier = `s:${msg.sessionId}`;
  const hints = (extra: { requestId?: string } = {}): NotificationHints => ({
    v: 1,
    kind: msg.kind,
    computerId: msg.computer,
    sessionId: msg.sessionId,
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
  });
  const heading = computer === "" ? project : `${computer} · ${project}`;

  if (msg.kind === "ask") {
    const ask = msg.ask;
    if (!ask) {
      return placeholder();
    }
    const what = clean(ask.title);
    const preview = ask.preview === undefined ? "" : clean(ask.preview);
    const more = ask.more !== undefined && ask.more > 0 ? ` · +${ask.more} more waiting` : "";
    const subject = preview === "" ? what : `${what}: ${preview}`;
    return {
      title: heading,
      ...(title !== "" ? { subtitle: title } : {}),
      body: `${subject}${more}`,
      category: categoryFor(ask),
      // Time Sensitive (decision 8): an agent is BLOCKED on this answer.
      interruptionLevel: "timeSensitive",
      sound: true,
      threadIdentifier,
      hints: hints({ requestId: ask.requestId }),
      placeholder: false,
    };
  }

  if (msg.kind === "ask_resolved") {
    return {
      title: heading,
      ...(title !== "" ? { subtitle: title } : {}),
      body: "Answered on another device",
      // It replaces the ask's banner by collapse id: nothing to act on.
      category: CATEGORY_OPEN,
      interruptionLevel: "passive",
      sound: false,
      threadIdentifier,
      hints: hints(),
      placeholder: false,
    };
  }

  if (msg.kind === "turn_failed") {
    const why = msg.turn?.error === undefined ? "" : clean(msg.turn.error);
    return {
      title: heading,
      ...(title !== "" ? { subtitle: title } : {}),
      body: why === "" ? "Turn failed" : `Turn failed: ${why}`,
      category: CATEGORY_OPEN,
      interruptionLevel: "passive",
      sound: false,
      threadIdentifier,
      hints: hints(),
      placeholder: false,
    };
  }

  // turn_done: quiet, grouped per session (decision 8).
  return {
    title: heading,
    ...(title !== "" ? { subtitle: title } : {}),
    body: "Turn finished",
    category: CATEGORY_OPEN,
    interruptionLevel: "passive",
    sound: false,
    threadIdentifier,
    hints: hints(),
    placeholder: false,
  };
}
