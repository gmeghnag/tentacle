/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: the dispatcher that
 * turns one notification response into a navigation or an answer. It is the seam
 * where "nothing a notification carries can make the phone send an answer" is
 * enforced end to end (decide → answer), so its refusals are asserted, not just
 * its happy path.
 */
import { describe, expect, test } from "bun:test";
import { encodeBase64Url } from "@tentacle/protocol";
import type { PushMessage } from "@tentacle/protocol";
import { publicKeyOf, sealPush } from "@tentacle/transport/push";
import type { AuthResult } from "../src/app-lock.ts";
import type { AnswerDeps } from "../src/notification-answer.ts";
import { MemoryAnswers, dispatchNotification } from "../src/notification-dispatch.ts";
import { notificationRoute } from "../src/notification-route.ts";

const NOW = 1_800_000_000_000;
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const computerSk = key(7);
const computerPk = publicKeyOf(computerSk);
const phoneSk = key(9);
const phonePk = publicKeyOf(phoneSk);
const otherSk = key(11);

const computers = [{ id: "c1", computerKey: encodeBase64Url(computerPk) }];
const pushKeys = [{ privateKey: encodeBase64Url(phoneSk) }];

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  v: 1,
  id: "0123456789abcdef0123456789abcdef",
  at: NOW,
  kind: "ask",
  computer: "c1",
  cwd: "/home/me/tentacle",
  sessionId: "s1",
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

const envelope = (msg: PushMessage, senderSk = computerSk): Record<string, unknown> => {
  const sealed = sealPush(new TextEncoder().encode(JSON.stringify(msg)), senderSk, phonePk, (n) =>
    new Uint8Array(n).fill(3),
  );
  return {
    tp: {
      v: 1,
      k: sealed.keyId,
      e: encodeBase64Url(sealed.enc),
      c: encodeBase64Url(sealed.ciphertext),
    },
  };
};

function rig(over: Partial<AnswerDeps> = {}) {
  const navigated: (string | object)[] = [];
  const refused: string[] = [];
  const answers: { requestId: string; allowed: boolean; message?: string }[] = [];
  const answerDeps: AnswerDeps = {
    links: {
      get: async () => ({
        hold: () => () => {},
        client: {
          isAttached: () => true,
          attachSession: async () => "s1",
          detachSession: async () => {},
          answerPermission: async (_s, requestId, response) => {
            answers.push({
              requestId,
              allowed: response.allowed,
              ...(response.message !== undefined ? { message: response.message } : {}),
            });
            return "sent";
          },
        },
      }),
    },
    authenticate: async () => "success" as AuthResult,
    scheduleFallback: () => () => {},
    inForeground: () => true,
    computerName: () => "MacBook",
    ...over,
  };
  const deps = {
    computers: async () => computers,
    pushKeys: async () => pushKeys,
    answered: new MemoryAnswers(),
    now: () => NOW,
    answer: answerDeps,
    route: (opened: { computer: { id: string }; message: PushMessage } | undefined) =>
      notificationRoute(opened, { has: (id) => id === "c1" }),
    navigate: (route: string | object) => navigated.push(route),
    refuse: (why: string) => refused.push(why),
  };
  return { deps, navigated, refused, answers, answerDeps };
}

describe("dispatchNotification: an answer goes out only from a verified plaintext", () => {
  test("Approve on a genuine push: Face ID, then allow_once", async () => {
    const r = rig();
    const outcome = await dispatchNotification(
      { actionId: "tentacle.approve", userInfo: envelope(message()) },
      r.deps,
    );
    expect(outcome.kind).toBe("answered");
    expect(r.answers).toEqual([{ requestId: "req-1", allowed: true }]);
  });

  test("a FORGED push: nothing is sent, and a tap lands on the computers list (F4)", async () => {
    // The end-to-end proof of Design 3: a perfect-looking `tn` and a forged
    // envelope send NOTHING.
    const r = rig();
    const forged = {
      ...envelope(message(), otherSk),
      tn: { v: 1, kind: "ask", computerId: "c1", sessionId: "s1", requestId: "req-1" },
    };
    const outcome = await dispatchNotification(
      { actionId: "tentacle.approve", userInfo: forged },
      r.deps,
    );
    expect(outcome).toEqual({ kind: "refused", why: "unverified" });
    expect(r.answers).toEqual([]);
    expect(r.refused).toEqual(["unverified"]);
    // A plain tap on it still opens the app (never a dead tap).
    const tap = await dispatchNotification({ actionId: "default", userInfo: forged }, r.deps);
    expect(tap).toEqual({ kind: "navigated", route: "computers" });
  });

  test("an Open tap navigates to the plaintext's session", async () => {
    const r = rig();
    const outcome = await dispatchNotification(
      { actionId: "tentacle.open", userInfo: envelope(message()) },
      r.deps,
    );
    expect(outcome).toEqual({
      kind: "navigated",
      route: { computerId: "c1", sessionId: "s1", title: "Fix the failing test", archived: false },
    });
  });

  test("a Reply rides as a refusal with the person's words", async () => {
    const r = rig();
    const withReply = message();
    const ask = withReply.ask;
    if (!ask) throw new Error("the fixture has no ask");
    await dispatchNotification(
      {
        actionId: "tentacle.reply",
        userInfo: envelope(message({ ask: { ...ask, reply: { maxChars: 100 } } })),
        userText: "use bun instead",
      },
      r.deps,
    );
    expect(r.answers).toEqual([{ requestId: "req-1", allowed: false, message: "use bun instead" }]);
  });

  test("a second tap of a duplicate notification is refused (answered-set, F18)", async () => {
    const r = rig();
    await dispatchNotification(
      { actionId: "tentacle.deny", userInfo: envelope(message()) },
      r.deps,
    );
    const second = await dispatchNotification(
      { actionId: "tentacle.deny", userInfo: envelope(message()) },
      r.deps,
    );
    expect(second).toEqual({ kind: "refused", why: "answered" });
    expect(r.answers).toHaveLength(1);
  });

  test("an Action tap on a turn notice navigates instead of answering", async () => {
    const r = rig();
    const outcome = await dispatchNotification(
      {
        actionId: "tentacle.approve",
        userInfo: envelope(message({ kind: "turn_done", ask: undefined })),
      },
      r.deps,
    );
    expect(outcome.kind).toBe("navigated");
    expect(r.answers).toEqual([]);
  });
});
