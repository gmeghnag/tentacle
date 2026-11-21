import { normalizePermissionReply } from "@tentacle/client";
/**
 * docs/feat/mobile-notifications.md Design 3 / slice N3: what an ACTION on a
 * notification MEANS, decided in pure code before anything is sent.
 *
 * The security rule this file exists for: **nothing a notification carries can
 * make the phone send an answer.** `userInfo.tn` (the relay-visible hints) is
 * never trusted — the response's `userInfo.tp` is re-OPENED here with the app's
 * own push keys and the computer key pinned at pairing (task 16's `openPush`,
 * HPKE Auth), and `requestId`, the offered option kinds and the reply bound come
 * from THAT plaintext. A forged push, a rewritten payload or a notification the
 * NSE never touched therefore yields `refuse: unverified`, and nothing is sent
 * (F4/F5/F6).
 *
 * Everything else is a rule about honesty — never a silent loss, never a silent
 * decision:
 *  - `Approve` is `allow_once` ONLY, and only when the ask offered one: a
 *    lasting rule needs the in-app sheet (decision 8).
 *  - `Deny` needs an offered `reject_once`.
 *  - `Reply` is a refusal carrying the person's words, clamped like the sheet
 *    (`normalizePermissionReply`); a blank Reply is `empty-reply` — the app then
 *    opens the sheet, because a blank field is not a No (F21).
 *  - A push older than 24 h (or more than 10 min in the future: a phone clock
 *    can be ahead) is `expired` — the same window the NSE applies (F6/F7).
 *  - An ask that was already ANSWERED here is `answered` (the app's own
 *    seen-answers set): one attempt per request (F18).
 */
import type { PermissionResponse } from "@tentacle/core";
import type { PushMessage } from "@tentacle/protocol";
import { PushEnvelopeSchema, PushMessageSchema, decodeBase64Url } from "@tentacle/protocol";
import { PUSH_TOOL_MAX, clipPushText } from "@tentacle/protocol";
import { type SealedPush, openPush } from "@tentacle/transport/push";
import { isRecordOfComputer } from "./computer-store.ts";
import type { SessionRoute } from "./routes.ts";

/** The team's wallet of ids the app has already answered, kept by the app (Design 3 step 3). */
export interface SeenAnswers {
  has(computerId: string, requestId: string): boolean;
  add(computerId: string, requestId: string): void;
}

/** One paired computer, as far as an answer needs it: the id and the PINNED key. */
export interface PinnedComputer {
  readonly id: string;
  readonly computerKey: string;
}

/** One of this phone's push keys (base64url), current or still-retained (F8). */
export interface PushKeyMaterial {
  readonly privateKey: string;
}

/** What `decideAction` may look at. All injected: no I/O, no clock, no Keychain. */
export interface DecideDeps {
  /** The `userInfo` the notification carried (untrusted). */
  readonly userInfo: unknown;
  /** The action id the person tapped (`notification-categories.ts`). */
  readonly actionId: string;
  /** The text of a `Reply…` action, when the phone collected one. */
  readonly userText?: string | undefined;
  /** Every computer this phone has paired: the pinned keys an envelope may authenticate against. */
  readonly computers: readonly PinnedComputer[];
  /** This phone's push private keys: the current one and (≤ 24 h) the previous (F8). */
  readonly pushKeys: readonly PushKeyMaterial[];
  /** The asks already answered from here. */
  readonly answered: SeenAnswers;
  /** The phone's clock (ms). */
  readonly now: number;
}

/** How stale a push may be before its actions no longer decide anything (F6). */
export const ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How far ahead of the phone's clock a push may be (a skewed clock is not a reason to act). */
export const ACTION_MAX_SKEW_MS = 10 * 60 * 1000;

/** An answer to send: the plaintext's own ids, and the response built from ITS options. */
export interface AnswerDecision {
  readonly do: "approve" | "deny" | "reply";
  readonly computerId: string;
  readonly sessionId: string;
  readonly requestId: string;
  /**
   * The tool the ask is about, from the SAME plaintext (never `userInfo.tn`).
   * The Face ID sheet names it ("Approve shell?"), so the person is told what
   * they are approving (Design 4 step 1; fix round 1, finding #5).
   */
  readonly tool: string;
  readonly response: PermissionResponse;
}

/** Something to open instead of acting. */
export interface OpenDecision {
  readonly do: "open";
  readonly route: SessionRoute | "computers";
}

/** A refusal, and why (the app says it, once, and offers the sheet). */
export interface RefuseDecision {
  readonly do: "refuse";
  readonly why: "unverified" | "expired" | "no-option" | "empty-reply" | "answered";
}

export type ActionDecision = AnswerDecision | OpenDecision | RefuseDecision;

/** Open on a session, or the computers list when the plaintext names none (`routes.ts`). */
function openRoute(msg: PushMessage | undefined): OpenDecision {
  if (!msg) {
    return { do: "open", route: "computers" };
  }
  return {
    do: "open",
    route: {
      computerId: msg.computer,
      sessionId: msg.sessionId,
      title: msg.title,
      archived: false,
    },
  };
}

/**
 * Open the envelope in `userInfo.tp` and validate the plaintext. Undefined when
 * it does not open: a wrong key id, a sender key that is not one of the pinned
 * computers, a flipped byte (the AEAD refuses), or a payload that does not parse
 * as a `PushMessage` this build knows.
 */
export function openNotification(
  userInfo: unknown,
  computers: readonly PinnedComputer[],
  pushKeys: readonly PushKeyMaterial[],
): { readonly message: PushMessage; readonly computer: PinnedComputer } | undefined {
  if (userInfo === null || typeof userInfo !== "object") {
    return undefined;
  }
  const envelope = PushEnvelopeSchema.safeParse((userInfo as { tp?: unknown }).tp);
  if (!envelope.success) {
    return undefined;
  }
  const { k, e, c } = envelope.data;
  const enc = decodeBase64Url(e);
  const ciphertext = decodeBase64Url(c);
  if (!enc || !ciphertext) {
    return undefined;
  }
  const sealed: SealedPush = { keyId: k, enc, ciphertext };
  // Every PAIRED computer is tried by its pinned key; the key id inside the
  // sealed form rules out all but (at most) one, and Auth mode makes a forgery
  // fail the AEAD even then (task 16 F6).
  for (const computer of computers) {
    const senderPub = decodeBase64Url(computer.computerKey);
    if (!senderPub) {
      continue;
    }
    for (const key of pushKeys) {
      const recipient = decodeBase64Url(key.privateKey);
      if (!recipient) {
        continue;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = openPush(sealed, recipient, senderPub);
      } catch {
        continue; // that key/computer pair is not it (or the blob was forged)
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        continue;
      }
      const message = PushMessageSchema.safeParse(parsed);
      if (!message.success) {
        return undefined; // it opened: a newer/unknown plaintext. Never half-read (F11).
      }
      if (!isRecordOfComputer(computer.id, message.data.computer)) {
        // The envelope authenticated as this computer but CLAIMS another: a
        // pinned key is the identity, so this is a broken/hostile sender.
        return undefined;
      }
      return { message: message.data, computer };
    }
  }
  return undefined;
}

/** The option kinds a `PushMessage`'s ask offers (`kind`, not `optionId`: the daemon's own vocabulary). */
function offers(msg: PushMessage, kind: "allow_once" | "reject_once"): boolean {
  return msg.ask?.options.some((option) => option.kind === kind) === true;
}

/**
 * Decide what one action tap means. Pure: it sends nothing (Design 4's
 * coordinator does), so every rule above is pinned without a phone.
 */
export function decideAction(deps: DecideDeps): ActionDecision {
  const opened = openNotification(deps.userInfo, deps.computers, deps.pushKeys);
  if (!opened) {
    // F4/F5/F16: forged, rewritten, or never decrypted. NOTHING is sent. An Open
    // tap still opens the app (it decides nothing), on the computers list — never
    // on a session the payload only CLAIMS. Every answer action refuses.
    return deps.actionId === "tentacle.open" || deps.actionId === "default"
      ? { do: "open", route: "computers" }
      : { do: "refuse", why: "unverified" };
  }
  const { message, computer } = opened;

  // A plain Open (or the default tap) needs no answer: route to the session.
  if (deps.actionId === "tentacle.open" || deps.actionId === "default") {
    return openRoute(message);
  }

  // An answer is only ever about an ASK: a turn notice or its resolution has
  // nothing to settle, so a crafted category cannot answer anything with it.
  const ask = message.ask;
  if (message.kind !== "ask" || !ask) {
    return openRoute(message);
  }

  const age = deps.now - message.at;
  if (age > ACTION_MAX_AGE_MS || age < -ACTION_MAX_SKEW_MS) {
    // Mutation: drop this → an old banner's Deny still decides a LIVE ask.
    return { do: "refuse", why: "expired" };
  }
  if (deps.answered.has(computer.id, ask.requestId)) {
    // Mutation: drop this → a double tap sends twice (harmless daemon-side, but
    // the phone would report the second as a failure and nag).
    return { do: "refuse", why: "answered" };
  }

  const base = {
    computerId: computer.id,
    sessionId: message.sessionId,
    requestId: ask.requestId,
    // The tool's own name from the plaintext, clipped like every other display
    // string: it lands in the Face ID sheet's sentence.
    tool: clipPushText(ask.tool, PUSH_TOOL_MAX),
  } as const;

  if (deps.actionId === "tentacle.approve") {
    if (!offers(message, "allow_once")) {
      return { do: "refuse", why: "no-option" };
    }
    // NEVER `scope: "session"`: a lasting rule is the sheet's decision.
    return { ...base, do: "approve", response: { allowed: true, scope: "once" } };
  }

  if (deps.actionId === "tentacle.deny") {
    if (!offers(message, "reject_once")) {
      return { do: "refuse", why: "no-option" };
    }
    return { ...base, do: "deny", response: { allowed: false } };
  }

  if (deps.actionId === "tentacle.reply") {
    if (!offers(message, "reject_once") || ask.reply === undefined) {
      // A refusal with words needs both a denial to carry them and the asker's
      // own bound: with no `reply` the daemon takes no text at all, so a reply
      // here is `empty-reply` (nothing sent, the sheet opens) — never a bare No.
      return { do: "refuse", why: ask.reply === undefined ? "empty-reply" : "no-option" };
    }
    const text = deps.userText ?? "";
    // The clamp is the SHEET's (`normalizePermissionReply`), so both surfaces
    // bound a reply identically; the daemon re-validates.
    const words = normalizePermissionReply(text, ask.reply.maxChars);
    if (words === null) {
      // F21: a blank Reply is not a silent Deny — the app opens the sheet.
      return { do: "refuse", why: "empty-reply" };
    }
    return { ...base, do: "reply", response: { allowed: false, message: words } };
  }

  // An action id this build does not know (an older notification, a new one):
  // nothing is sent.
  return { do: "refuse", why: "unverified" };
}
