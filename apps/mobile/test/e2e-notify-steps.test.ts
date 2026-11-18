/**
 * docs/feat/mobile-notifications.md slice N8: the flow-side helpers. Pure, so the
 * flows' facts are pinned without a simulator — and, most importantly, the
 * `seal-push` helper really seals to the device's key with the computer's static
 * key (a hand-written payload would prove nothing about the app's decrypt path).
 */
import { describe, expect, test } from "bun:test";
import { decodeBase64Url } from "@tentacle/protocol";
import type { PushMessage } from "@tentacle/protocol";
import { openPush, publicKeyOf } from "@tentacle/transport/push";
import { payloadFor, sealPushMessage } from "../e2e/notify-steps.ts";

const computerSk = new Uint8Array(32).fill(7);
const computerPk = publicKeyOf(computerSk);
const deviceSk = new Uint8Array(32).fill(9);
const devicePk = publicKeyOf(deviceSk);

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  v: 1,
  id: "0123456789abcdef0123456789abcdef",
  at: 1_800_000_000_000,
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

describe("sealPushMessage + payloadFor", () => {
  test("the payload really opens with the device key and the computer's pinned key", () => {
    // Mutation: hand-write `tp` → the app's decrypt path is never exercised, and
    // every notification flow would pass on a payload nothing can open.
    const sealed = sealPushMessage(message(), computerSk, devicePk, (n) =>
      new Uint8Array(n).fill(3),
    );
    const payload = payloadFor(sealed);
    const tp = payload.tp as { v: number; k: string; e: string; c: string };
    expect(tp.v).toBe(1);
    const e = decodeBase64Url(tp.e);
    const c = decodeBase64Url(tp.c);
    if (!e || !c) throw new Error("the payload's bytes did not decode");
    const opened = openPush({ keyId: tp.k, enc: e, ciphertext: c }, deviceSk, computerPk);
    expect(JSON.parse(new TextDecoder().decode(opened)).ask.requestId).toBe("req-1");
  });

  test("the outer `aps` carries mutable-content so the NSE runs (task 16 P4)", () => {
    const sealed = sealPushMessage(message(), computerSk, devicePk, (n) =>
      new Uint8Array(n).fill(3),
    );
    expect(payloadFor(sealed).aps["mutable-content"]).toBe(1);
  });

  test("a flow can place a HOSTILE aps (F5), and the envelope is unchanged", () => {
    const sealed = sealPushMessage(message(), computerSk, devicePk, (n) =>
      new Uint8Array(n).fill(3),
    );
    const plain = payloadFor(sealed);
    const hostile = payloadFor(sealed, { category: "tentacle.ask", alert: { body: "rm -rf /" } });
    expect(hostile.tp).toEqual(plain.tp);
    expect(hostile.aps.category).toBe("tentacle.ask");
  });
});
