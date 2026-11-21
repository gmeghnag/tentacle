/**
 * docs/feat/mobile-notifications.md Design 3 / slice N3. The one property this
 * file exists to prove: **nothing a notification carries can make the phone send
 * an answer** — the answer comes from a plaintext THIS code opened and
 * authenticated, never from `userInfo.tn`. Each test names its mutation (AGENTS §9).
 *
 * Rig: real envelopes, sealed with `sealPush` from a "computer" key pair to a
 * "phone" push key, exactly as task 16's daemon does.
 */
import { describe, expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url } from "@tentacle/protocol";
import type { PushMessage } from "@tentacle/protocol";
import { pushKeyId, sealPush } from "@tentacle/transport/push";
import {
  ACTION_MAX_AGE_MS,
  ACTION_MAX_SKEW_MS,
  type PinnedComputer,
  type SeenAnswers,
  decideAction,
  openNotification,
} from "../src/notification-action.ts";

const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();

/** Deterministic private keys (the crypto is not what is under test). */
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill === 0 ? 1 : fill);

/** x25519's public half, via the same helper `sealPush` uses. */
import { publicKeyOf } from "@tentacle/transport/push";

const computerSk = key(7);
const computerPk = publicKeyOf(computerSk);
const phoneSk = key(9);
const phonePk = publicKeyOf(phoneSk);
const otherComputerSk = key(11);
const otherComputerPk = publicKeyOf(otherComputerSk);

const computer: PinnedComputer = {
  id: "computer-1",
  computerKey: encodeBase64Url(computerPk),
};
const computers = [computer];
const pushKeys = [{ privateKey: encodeBase64Url(phoneSk) }];

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  v: 1,
  id: "0123456789abcdef0123456789abcdef",
  at: NOW,
  kind: "ask",
  computer: "computer-1",
  cwd: "/home/me/tentacle",
  sessionId: "sess-1",
  title: "Fix the failing test",
  ask: {
    requestId: "req-1",
    tool: "shell",
    title: "Run a shell command",
    preview: "rm -rf build",
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ],
  },
  ...over,
});

/** The `userInfo` of a real push: `{tp: envelope}` as the relay carries it. */
function envelopeOf(msg: PushMessage, senderSk = computerSk, recipientPk = phonePk): object {
  const sealed = sealPush(
    new Uint8Array(encoder.encode(JSON.stringify(msg))),
    senderSk,
    recipientPk,
    (length) => new Uint8Array(length).fill(3),
  );
  return {
    tp: {
      v: 1,
      k: sealed.keyId,
      e: encodeBase64Url(sealed.enc),
      c: encodeBase64Url(sealed.ciphertext),
    },
  };
}

class Answers implements SeenAnswers {
  private readonly ids = new Set<string>();
  has(computerId: string, requestId: string): boolean {
    return this.ids.has(`${computerId}\u0000${requestId}`);
  }
  add(computerId: string, requestId: string): void {
    this.ids.add(`${computerId}\u0000${requestId}`);
  }
}

const decide = (
  over: Partial<Parameters<typeof decideAction>[0]> = {},
): ReturnType<typeof decideAction> =>
  decideAction({
    userInfo: envelopeOf(message()),
    actionId: "tentacle.deny",
    computers,
    pushKeys,
    answered: new Answers(),
    now: NOW,
    ...over,
  });

describe("the plaintext is the authority, never userInfo.tn (Design 3)", () => {
  test("a forged envelope (a sender key that is NOT the pinned computer) refuses `unverified`", () => {
    // Mutation: trust `userInfo.tn.requestId` (or skip opening the seal) → this
    // returns an answer, and a hostile relay could decide a permission.
    const forged = envelopeOf(message(), otherComputerSk);
    const decision = decide({
      userInfo: {
        ...forged,
        // Every hint a hostile relay could invent, all pointing at a real ask.
        tn: {
          v: 1,
          kind: "ask",
          computerId: "computer-1",
          sessionId: "sess-1",
          requestId: "req-1",
        },
        category: "tentacle.ask",
        alert: "Run a shell command: rm -rf build",
      },
      actionId: "tentacle.approve",
    });
    expect(decision).toEqual({ do: "refuse", why: "unverified" });
  });

  test("a flipped ciphertext byte refuses `unverified` (the AEAD's tag)", () => {
    const real = envelopeOf(message()) as { tp: { c: string } };
    const bytes = decodeBase64Url(real.tp.c);
    if (!bytes) throw new Error("the fixture's ciphertext did not decode");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const decision = decide({
      userInfo: { tp: { ...real.tp, c: encodeBase64Url(bytes) } },
      actionId: "tentacle.approve",
    });
    expect(decision).toEqual({ do: "refuse", why: "unverified" });
  });

  test("no envelope at all refuses `unverified`", () => {
    expect(decide({ userInfo: {}, actionId: "tentacle.approve" })).toEqual({
      do: "refuse",
      why: "unverified",
    });
    expect(decide({ userInfo: null, actionId: "tentacle.deny" })).toEqual({
      do: "refuse",
      why: "unverified",
    });
  });

  test("the answer's ids come from the PLAINTEXT: a rewritten tn is ignored", () => {
    const decision = decide({
      userInfo: {
        ...envelopeOf(message({ sessionId: "the-real-session" })),
        tn: { v: 1, kind: "ask", computerId: "computer-1", sessionId: "evil", requestId: "evil" },
      },
      actionId: "tentacle.deny",
    });
    expect(decision).toEqual({
      do: "deny",
      computerId: "computer-1",
      sessionId: "the-real-session",
      requestId: "req-1",
      // The tool too: it is what the Face ID sheet names (fix round 1, #5).
      tool: "shell",
      response: { allowed: false },
    });
  });

  test("another phone's push key cannot open it (this phone's keys are the only ones tried)", () => {
    const decision = decide({
      userInfo: envelopeOf(message(), computerSk, publicKeyOf(key(13))),
      actionId: "tentacle.deny",
    });
    expect(decision).toEqual({ do: "refuse", why: "unverified" });
  });

  test("the PREVIOUS push key (still retained, F8) still opens; an unpaired computer does not", () => {
    const previous = { privateKey: encodeBase64Url(key(21)) };
    const userInfo = envelopeOf(message(), computerSk, publicKeyOf(key(21)));
    // The current key alone: refused.
    expect(decide({ userInfo, actionId: "tentacle.deny" })).toEqual({
      do: "refuse",
      why: "unverified",
    });
    // With the retained previous key: it opens.
    expect(decide({ userInfo, pushKeys: [previous], actionId: "tentacle.deny" })).toMatchObject({
      do: "deny",
      requestId: "req-1",
    });
  });
});

describe("Approve is allow_once only (decision 8)", () => {
  test("approve on an ask that offers allow_once → scope once", () => {
    expect(decide({ actionId: "tentacle.approve" })).toEqual({
      do: "approve",
      computerId: "computer-1",
      sessionId: "sess-1",
      requestId: "req-1",
      tool: "shell",
      response: { allowed: true, scope: "once" },
    });
  });

  test("NEVER a lasting rule: the response carries scope once, even when allow_always is offered", () => {
    // Mutation: `scope: "session"` (or map Approve to `allow_always`) → red.
    const decision = decide({
      userInfo: envelopeOf(
        message({
          ask: {
            requestId: "req-1",
            tool: "shell",
            title: "Run a shell command",
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
            ],
          },
        }),
      ),
      actionId: "tentacle.approve",
    });
    expect(decision).toMatchObject({ do: "approve", response: { allowed: true, scope: "once" } });
    expect(decision.do === "approve" ? decision.response.scope : "none").toBe("once");
  });

  test("an ask with no allow_once: `no-option`, nothing sent", () => {
    const decision = decide({
      userInfo: envelopeOf(
        message({
          ask: {
            requestId: "req-1",
            tool: "shell",
            title: "Run a shell command",
            options: [{ optionId: "allow_always", name: "Allow always", kind: "allow_always" }],
          },
        }),
      ),
      actionId: "tentacle.approve",
    });
    expect(decision).toEqual({ do: "refuse", why: "no-option" });
  });

  test("Deny without an offered reject_once: `no-option`", () => {
    const decision = decide({
      userInfo: envelopeOf(
        message({
          ask: {
            requestId: "req-1",
            tool: "shell",
            title: "Run a shell command",
            options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
          },
        }),
      ),
      actionId: "tentacle.deny",
    });
    expect(decision).toEqual({ do: "refuse", why: "no-option" });
  });
});

describe("Reply: the person's words, clamped, never silently a No", () => {
  const withReply = (maxChars = 1000) =>
    envelopeOf(
      message({
        ask: {
          requestId: "req-1",
          tool: "shell",
          title: "Run a shell command",
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
          reply: { maxChars },
        },
      }),
    );

  test("the text rides as a refusal, normalized and clamped to the ask's maxChars", () => {
    // Mutation: skip the clamp → the daemon refuses it (or takes more than the
    // asker allows) — a reply the sheet would have shortened.
    const decision = decide({
      userInfo: withReply(5),
      actionId: "tentacle.reply",
      userText: "  please\r\nuse bun instead  ",
    });
    expect(decision).toMatchObject({
      do: "reply",
      response: { allowed: false, message: "pleas" },
    });
  });

  test("a blank (or whitespace-only) reply: `empty-reply`, nothing sent", () => {
    // Mutation: send a bare refusal instead → a silent Deny behind the person's back.
    expect(decide({ userInfo: withReply(), actionId: "tentacle.reply", userText: "   " })).toEqual({
      do: "refuse",
      why: "empty-reply",
    });
    expect(decide({ userInfo: withReply(), actionId: "tentacle.reply" })).toEqual({
      do: "refuse",
      why: "empty-reply",
    });
  });

  test("a reply without an offered reject_once: `no-option`", () => {
    const decision = decide({
      userInfo: envelopeOf(
        message({
          ask: {
            requestId: "req-1",
            tool: "shell",
            title: "t",
            options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
            reply: { maxChars: 100 },
          },
        }),
      ),
      actionId: "tentacle.reply",
      userText: "use bun",
    });
    expect(decision).toEqual({ do: "refuse", why: "no-option" });
  });

  test("a Reply on an ask that takes no text at all is `empty-reply`, never a bare No (F21)", () => {
    // Such an ask's category has no Reply action (`push-render.ts`), so this is
    // defence in depth: with no `reply.maxChars` nothing survives the clamp and
    // NOTHING is sent — the app opens the sheet.
    expect(decide({ actionId: "tentacle.reply", userText: "hi" })).toEqual({
      do: "refuse",
      why: "empty-reply",
    });
  });
});

describe("age and answered-set: a stale or repeated tap decides nothing", () => {
  test("the 24 h boundary, ±1 ms (mutation: drop the age guard → red)", () => {
    const at = NOW - ACTION_MAX_AGE_MS;
    expect(
      decide({ userInfo: envelopeOf(message({ at })), actionId: "tentacle.deny" }),
    ).toMatchObject({ do: "deny" });
    expect(
      decide({ userInfo: envelopeOf(message({ at: at - 1 })), actionId: "tentacle.deny" }),
    ).toEqual({ do: "refuse", why: "expired" });
  });

  test("a push from the future (a skewed clock) beyond 10 min is expired; inside it is fine", () => {
    const at = NOW + ACTION_MAX_SKEW_MS;
    expect(
      decide({ userInfo: envelopeOf(message({ at })), actionId: "tentacle.deny" }),
    ).toMatchObject({ do: "deny" });
    expect(
      decide({ userInfo: envelopeOf(message({ at: at + 1 })), actionId: "tentacle.deny" }),
    ).toEqual({ do: "refuse", why: "expired" });
  });

  test("an ask already answered here: `answered` (one attempt per request, F18)", () => {
    const answered = new Answers();
    expect(decide({ actionId: "tentacle.deny", answered })).toMatchObject({ do: "deny" });
    answered.add("computer-1", "req-1");
    expect(decide({ actionId: "tentacle.deny", answered })).toEqual({
      do: "refuse",
      why: "answered",
    });
    // Another computer's identical requestId is its own ask (ids are per daemon).
    answered.add("computer-2", "req-1");
    expect(decide({ actionId: "tentacle.deny", answered: new Answers() })).toMatchObject({
      do: "deny",
    });
  });
});

describe("Open, and everything that is not an ask", () => {
  test("the default tap and Open route to the session named by the plaintext", () => {
    expect(decide({ actionId: "tentacle.open" })).toEqual({
      do: "open",
      route: {
        computerId: "computer-1",
        sessionId: "sess-1",
        title: "Fix the failing test",
        archived: false,
      },
    });
  });

  test("Open on a notification that does not open: the computers list (never a guessed session)", () => {
    expect(decide({ userInfo: {}, actionId: "tentacle.open" })).toEqual({
      do: "open",
      route: "computers",
    });
    // A default tap too: the app opens, nothing is decided.
    expect(decide({ userInfo: {}, actionId: "default" })).toEqual({
      do: "open",
      route: "computers",
    });
  });

  test("an Approve tap on a turn notice answers nothing: it opens the session instead", () => {
    // Mutation: answer anyway (an empty ask read as "no options offered") → red.
    expect(
      decide({
        userInfo: envelopeOf(message({ kind: "turn_done", ask: undefined })),
        actionId: "tentacle.approve",
      }),
    ).toEqual({
      do: "open",
      route: {
        computerId: "computer-1",
        sessionId: "sess-1",
        title: "Fix the failing test",
        archived: false,
      },
    });
  });

  test("an unknown action id refuses (nothing is sent)", () => {
    expect(decide({ actionId: "tentacle.something-new" })).toEqual({
      do: "refuse",
      why: "unverified",
    });
  });
});

describe("openNotification (the seam itself)", () => {
  test("names the pinned computer that authenticated it", () => {
    const opened = openNotification(envelopeOf(message()), computers, pushKeys);
    expect(opened?.computer.id).toBe("computer-1");
    expect(opened?.message.ask?.requestId).toBe("req-1");
  });

  test("a plaintext claiming ANOTHER computer is refused, even under a pinned key", () => {
    // Mutation: identify the computer from the plaintext's own `computer` → red: a
    // daemon could then attribute its push to an unpinned peer.
    expect(
      openNotification(envelopeOf(message({ computer: "computer-2" })), computers, pushKeys),
    ).toBeUndefined();
  });

  test("a PROJECT record of the claimed computer opens it (docs/feat/mobile-projects.md §6 id ripple; mutation: compare the record id whole → red)", () => {
    const projectRecord: PinnedComputer = {
      id: "computer-1.0123456789abcdef",
      computerKey: computer.computerKey,
    };
    const opened = openNotification(envelopeOf(message()), [projectRecord], pushKeys);
    expect(opened?.computer.id).toBe("computer-1.0123456789abcdef");
    // …and a record whose id merely STARTS with the claim (no dot) is another computer.
    const lookalike: PinnedComputer = { id: "computer-10", computerKey: computer.computerKey };
    expect(openNotification(envelopeOf(message()), [lookalike], pushKeys)).toBeUndefined();
  });

  test("an unparsable plaintext (a future version) is refused, never half-read (F11)", () => {
    const future = envelopeOf({ ...message(), v: 9 } as unknown as PushMessage);
    expect(openNotification(future, computers, pushKeys)).toBeUndefined();
    const broken = sealPush(encoder.encode("not json"), computerSk, phonePk, (n) =>
      new Uint8Array(n).fill(3),
    );
    expect(
      openNotification(
        {
          tp: {
            v: 1,
            k: broken.keyId,
            e: encodeBase64Url(broken.enc),
            c: encodeBase64Url(broken.ciphertext),
          },
        },
        computers,
        pushKeys,
      ),
    ).toBeUndefined();
  });

  test("the key id names the computer: an envelope for another computer's kid is refused before decryption", () => {
    expect(pushKeyId(computerPk)).not.toBe(pushKeyId(otherComputerPk));
    expect(
      openNotification(envelopeOf(message(), otherComputerSk), computers, pushKeys),
    ).toBeUndefined();
  });
});
