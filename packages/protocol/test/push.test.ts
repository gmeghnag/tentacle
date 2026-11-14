/**
 * The push wire (docs/feat/mobile-push.md Design 3, slice P2): the sealed
 * plaintext (`PushMessage`), its APNs envelope (`PushPayload`), the clip limits,
 * and `device/push_register` / `device/push_unregister`.
 *
 * Three properties carry the slice, and every test names the mutation that
 * breaks it (AGENTS §9):
 *  - the plaintext ALWAYS fits what a push can carry (`fitPushMessage`), so a
 *    worst-case message is still one 2048-byte bucket → ≤ 4096 bytes of APNs
 *    payload once sealed and enveloped;
 *  - clipping never produces a string the wire (or Swift) cannot decode — no
 *    split surrogate pair, no lone surrogate, no control character;
 *  - the register params are strict enough that a bad token, key or env is
 *    `InvalidParams` and nothing is written (F26).
 */
import { describe, expect, test } from "bun:test";
import { maxPushPlaintextBytes, sealPush } from "../../transport/src/push-seal.ts";
import {
  DEFAULT_PUSH_GRACE_SECONDS,
  DevicePushRegisterParamsSchema,
  DevicePushRegisterResultSchema,
  DevicePushUnregisterParamsSchema,
  Method,
  PUSH_DELIVERY_STATUSES,
  PUSH_ENVELOPE_CIPHERTEXT_LENGTHS,
  PUSH_GRACE_MAX_SECONDS,
  PUSH_PLAINTEXT_MAX_BYTES,
  PushEnvelopeSchema,
  PushMessageSchema,
  PushPayloadSchema,
  RequestSchemas,
  clipPushText,
  fitPushMessage,
  isMethodName,
  isPushDeliveryStatus,
  pushCollapseIdOf,
} from "../src/index.ts";

/** Every text field at its schema cap, in 4-byte UTF-8 characters (the worst case the plan names). */
const EMOJI = "😀";
const at = (max: number) => EMOJI.repeat(Math.ceil(max / 2)).slice(0, max);

const worstCase = () => ({
  v: 1 as const,
  id: "a".repeat(32),
  at: 1_763_000_000_000,
  kind: "ask" as const,
  computer: at(64),
  cwd: at(4096),
  sessionId: at(128),
  title: at(200),
  ask: {
    requestId: at(128),
    tool: at(128),
    title: at(300),
    preview: at(500),
    options: Array.from({ length: 8 }, () => ({
      optionId: at(64),
      kind: "allow_once" as const,
      name: at(120),
    })),
    reply: { maxChars: 4000 },
    more: 99,
  },
});

describe("PushMessage (the sealed plaintext)", () => {
  test("round-trips, and an unknown field is stripped (strip schema, AGENTS §7)", () => {
    const message = {
      v: 1 as const,
      id: "b".repeat(32),
      at: 1_763_000_000_000,
      kind: "turn_done" as const,
      computer: "laptop",
      cwd: "/Users/g/proj",
      sessionId: "s1",
      title: "Fix the login bug",
      turn: { turnId: "t1" },
    };
    expect(PushMessageSchema.parse(message)).toEqual(message);
    const extra = PushMessageSchema.parse({ ...message, future: 1, body: "clear text" });
    expect(extra).toEqual(message);
    // A plaintext field the daemon must never smuggle in is not a field at all.
    expect("body" in extra).toBe(false);
  });

  test("`v` and `kind` are closed: a wrong version or an unknown kind is refused", () => {
    const base = worstCase();
    expect(PushMessageSchema.safeParse({ ...base, v: 2 }).success).toBe(false);
    expect(PushMessageSchema.safeParse({ ...base, kind: "alert" }).success).toBe(false);
    for (const kind of ["ask", "ask_resolved", "turn_done", "turn_failed"] as const) {
      expect(PushMessageSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
  });

  test("every text field is capped (the clip limits are the schema's own bounds)", () => {
    const base = {
      v: 1 as const,
      id: "c".repeat(32),
      at: 1,
      kind: "turn_done" as const,
      computer: "laptop",
      cwd: "/w",
      sessionId: "s",
      title: "t",
    };
    for (const [field, max] of [
      ["computer", 64],
      ["cwd", 4096],
      ["sessionId", 128],
      ["title", 200],
    ] as const) {
      expect(PushMessageSchema.safeParse({ ...base, [field]: "x".repeat(max) }).success).toBe(true);
      expect(PushMessageSchema.safeParse({ ...base, [field]: "x".repeat(max + 1) }).success).toBe(
        false,
      );
    }
    // A control character never reaches a notification centre (`line`).
    expect(PushMessageSchema.safeParse({ ...base, title: "a\u001bb" }).success).toBe(false);
    // An ask's own fields, and the option list, are bounded too.
    const ask = {
      requestId: "r",
      tool: "shell",
      title: "Run it?",
      options: [{ optionId: "o1", kind: "allow_once", name: "Allow" }],
    };
    expect(PushMessageSchema.safeParse({ ...base, kind: "ask", ask }).success).toBe(true);
    expect(
      PushMessageSchema.safeParse({ ...base, kind: "ask", ask: { ...ask, options: [] } }).success,
    ).toBe(false);
    expect(
      PushMessageSchema.safeParse({
        ...base,
        kind: "ask",
        ask: { ...ask, options: Array.from({ length: 9 }, () => ask.options[0]) },
      }).success,
    ).toBe(false);
  });
});

describe("clipPushText / fitPushMessage (the size guarantee)", () => {
  test("clipPushText cuts on code-point boundaries, to UTF-8 BYTES, and drops what UTF-8 cannot carry", () => {
    // 30 bytes of a 4-byte character: 7 whole characters, never half of one.
    expect(clipPushText(EMOJI.repeat(10), 30)).toBe(EMOJI.repeat(7));
    // A budget too small for the next character stops BEFORE it (no lone surrogate).
    const clipped = clipPushText(`${"a".repeat(10)}${EMOJI}`, 11);
    expect(clipped).toBe("a".repeat(10));
    expect(clipped.isWellFormed()).toBe(true);
    // A string that already holds a lone surrogate is repaired, not passed on:
    // JSON.stringify would escape it and Swift could not decode it.
    expect(clipPushText("a\uD83D", 100)).toBe("a");
    expect(clipPushText("a\uDE00b", 100)).toBe("ab");
    // Control characters are removed (the same rule as the wire's `line`).
    expect(clipPushText("a\u0000b\u001bc", 100)).toBe("abc");
    // Nothing usable left is "", never a half character.
    expect(clipPushText(EMOJI, 3)).toBe("");
    expect(clipPushText("\u0000", 100)).toBe("");
    expect(clipPushText("abc", 0)).toBe("");
  });

  test("fitPushMessage: a message with EVERY field at its cap still fits one 2048-byte bucket", () => {
    const bytes = fitPushMessage(worstCase());
    expect(bytes.length).toBeLessThanOrEqual(PUSH_PLAINTEXT_MAX_BYTES);
    // The plan's exact bound: the constant must be transport's own.
    expect(PUSH_PLAINTEXT_MAX_BYTES).toBe(maxPushPlaintextBytes());
    // …and what it produces is a valid message: clipping never invents a shape.
    const parsed = PushMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    expect(parsed.success).toBe(true);
  });

  test("fitPushMessage: sealed + enveloped + the relay's fixed `aps` ≤ 4096 bytes of APNs payload", () => {
    // The aps template is P4's (`apps/relay/src/apns.ts`); inlined here as a
    // literal because this test pins the JOINT bound of the two slices.
    const APS =
      '{"aps":{"alert":{"title":"tentacle","body":"Open tentacle to see what\'s new"},"mutable-content":1,"sound":"default"}}';
    const senderStatic = new Uint8Array(32).fill(7);
    const recipient = new Uint8Array(32).fill(9);
    const sealed = sealPush(fitPushMessage(worstCase()), senderStatic, recipient, () => {
      return new Uint8Array(32).fill(3);
    });
    // The three visible sizes only (P1): 528/1040/2064 bytes → 704/1387/2752 chars.
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
    const envelope = {
      v: 1 as const,
      k: sealed.keyId,
      e: b64(sealed.enc),
      c: b64(sealed.ciphertext),
    };
    expect(PushEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect([...PUSH_ENVELOPE_CIPHERTEXT_LENGTHS]).toContain(envelope.c.length);
    // The relay's request body: its fixed aps + the payload, serialized once.
    const payload = PushPayloadSchema.parse({ tp: envelope });
    const body = `{"aps":${APS.slice(7)},"tp":${JSON.stringify(payload.tp)}}`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
  });

  test("fitPushMessage trims the least important text first, and never below one character", () => {
    const base = {
      v: 1 as const,
      id: "d".repeat(32),
      at: 1,
      kind: "ask" as const,
      computer: "laptop",
      cwd: "/w",
      sessionId: "s",
      title: "TITLE",
      ask: {
        requestId: "r",
        tool: "shell",
        title: "ASK",
        preview: "PREVIEW",
        options: [{ optionId: "o1", kind: "allow_once" as const, name: "Allow" }],
      },
    };
    // A message that already fits is passed through UNCHANGED (no gratuitous churn).
    const unchanged = fitPushMessage(base);
    expect(JSON.parse(new TextDecoder().decode(unchanged))).toEqual(base);
    // A preview is the first thing to go: it carries the least.
    const trimmed = JSON.parse(
      new TextDecoder().decode(
        fitPushMessage({ ...base, ask: { ...base.ask, preview: EMOJI.repeat(1000) } }),
      ),
    ) as { ask: { preview?: string; title: string; tool: string } };
    expect(trimmed.ask.preview === undefined || trimmed.ask.preview.length < 4000).toBe(true);
    expect(trimmed.ask.title).toBe("ASK");
    expect(trimmed.ask.tool).toBe("shell");
  });
});

describe("PushEnvelope / PushPayload (what the relay carries)", () => {
  test("the envelope's three fields are validated by shape", () => {
    const ok = { v: 1 as const, k: "k".repeat(12), e: "e".repeat(43), c: "c".repeat(704) };
    expect(PushEnvelopeSchema.parse(ok)).toEqual(ok);
    expect(PushEnvelopeSchema.safeParse({ ...ok, v: 0 }).success).toBe(false);
    expect(PushEnvelopeSchema.safeParse({ ...ok, k: "k".repeat(11) }).success).toBe(false);
    expect(PushEnvelopeSchema.safeParse({ ...ok, e: "e".repeat(42) }).success).toBe(false);
    // The ciphertext is one of three buckets — never an arbitrary length.
    expect(PushEnvelopeSchema.safeParse({ ...ok, c: "c".repeat(703) }).success).toBe(false);
    expect(PushEnvelopeSchema.safeParse({ ...ok, c: "c".repeat(2752) }).success).toBe(true);
    expect(PushEnvelopeSchema.safeParse({ ...ok, c: "c".repeat(2753) }).success).toBe(false);
    // Non-canonical alphabet (padding, + and /) is refused, not reinterpreted.
    expect(PushEnvelopeSchema.safeParse({ ...ok, c: `${"c".repeat(703)}=` }).success).toBe(false);
    // A key id is 12 base64url characters (P1's `PUSH_KID_LENGTH`).
    expect(PushEnvelopeSchema.safeParse({ ...ok, k: "-_".repeat(6) }).success).toBe(true);
  });

  test("the payload is `{tp}`, and an `aps` a daemon tries to supply is STRIPPED", () => {
    // The relay builds `aps` from its own template (P4): a daemon-supplied one
    // must never survive the parse, or a peer could put plaintext in a banner.
    const tp = { v: 1 as const, k: "k".repeat(12), e: "e".repeat(43), c: "c".repeat(704) };
    const parsed = PushPayloadSchema.parse({
      tp,
      aps: { alert: { title: "tentacle", body: "plaintext the relay never authorised" } },
    });
    expect(parsed).toEqual({ tp });
    expect("aps" in parsed).toBe(false);
  });
});

describe("device/push_register + device/push_unregister", () => {
  const good = { token: "a".repeat(64), env: "sandbox" as const, key: "k".repeat(43) };

  test("both are registered methods, with params + result schemas", () => {
    expect(isMethodName("device/push_register")).toBe(true);
    expect(isMethodName("device/push_unregister")).toBe(true);
    expect(Method.DevicePushRegister).toBe("device/push_register");
    expect(Method.DevicePushUnregister).toBe("device/push_unregister");
    for (const name of [Method.DevicePushRegister, Method.DevicePushUnregister]) {
      expect(RequestSchemas[name]?.params).toBeDefined();
      expect(RequestSchemas[name]?.result).toBeDefined();
    }
    // The unregister takes nothing: `{}` and nothing else matters.
    expect(DevicePushUnregisterParamsSchema.parse({})).toEqual({});
    expect(RequestSchemas[Method.DevicePushUnregister].params.safeParse({}).success).toBe(true);
    expect(RequestSchemas[Method.DevicePushUnregister].result.safeParse({}).success).toBe(true);
  });

  test("a bad token, env or key is InvalidParams — nothing half-valid gets through (F26)", () => {
    expect(DevicePushRegisterParamsSchema.safeParse(good).success).toBe(true);
    // The APNs token: lowercase hex, 64–200 characters (a rotated/odd token still fits).
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, token: "a".repeat(63) }).success,
    ).toBe(false);
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, token: "a".repeat(200) }).success,
    ).toBe(true);
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, token: "a".repeat(201) }).success,
    ).toBe(false);
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, token: "A".repeat(64) }).success,
    ).toBe(false);
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, token: "z".repeat(64) }).success,
    ).toBe(false);
    // The environment is closed: an unknown one is never a guess.
    expect(DevicePushRegisterParamsSchema.safeParse({ ...good, env: "staging" }).success).toBe(
      false,
    );
    expect(DevicePushRegisterParamsSchema.safeParse({ ...good, env: "production" }).success).toBe(
      true,
    );
    // The push key is an X25519 public key: 32 bytes, base64url, 43 characters.
    expect(DevicePushRegisterParamsSchema.safeParse({ ...good, key: "k".repeat(42) }).success).toBe(
      false,
    );
    expect(DevicePushRegisterParamsSchema.safeParse({ ...good, key: "k".repeat(44) }).success).toBe(
      false,
    );
    expect(
      DevicePushRegisterParamsSchema.safeParse({ ...good, key: `${"k".repeat(42)}=` }).success,
    ).toBe(false);
    expect(DevicePushRegisterParamsSchema.safeParse({ token: good.token }).success).toBe(false);
  });

  test("an unknown field is stripped from the params (v10 forward compat)", () => {
    const parsed = DevicePushRegisterParamsSchema.parse({ ...good, future: "x" });
    expect(parsed).toEqual(good);
    expect("future" in parsed).toBe(false);
  });

  test("the result says WHY, and the grace the daemon uses", () => {
    const result = {
      graceSeconds: DEFAULT_PUSH_GRACE_SECONDS,
      push: "on" as const,
    };
    expect(DevicePushRegisterResultSchema.parse(result)).toEqual(result);
    for (const push of ["on", "off", "relay-off", "relay-no-push"] as const) {
      expect(DevicePushRegisterResultSchema.safeParse({ ...result, push }).success).toBe(true);
    }
    expect(DevicePushRegisterResultSchema.safeParse({ ...result, push: "maybe" }).success).toBe(
      false,
    );
    // The grace range the config validates: 0 (at once) … 3600.
    expect(DEFAULT_PUSH_GRACE_SECONDS).toBe(30);
    expect(PUSH_GRACE_MAX_SECONDS).toBe(3600);
    expect(DevicePushRegisterResultSchema.safeParse({ ...result, graceSeconds: 0 }).success).toBe(
      true,
    );
    expect(DevicePushRegisterResultSchema.safeParse({ ...result, graceSeconds: -1 }).success).toBe(
      false,
    );
    expect(
      DevicePushRegisterResultSchema.safeParse({ ...result, graceSeconds: 3601 }).success,
    ).toBe(false);
  });
});

describe("the delivery vocabulary (shared by the relay frame and the daemon's sink)", () => {
  test("the five statuses, and the membership test the relay link branches on", () => {
    expect([...PUSH_DELIVERY_STATUSES]).toEqual([
      "sent",
      "gone",
      "rejected",
      "throttled",
      "unavailable",
    ]);
    expect(isPushDeliveryStatus("gone")).toBe(true);
    expect(isPushDeliveryStatus("delivered")).toBe(false);
  });

  test("a collapse id is opaque, header-safe and ≤ 64 bytes", () => {
    // `apns-collapse-id` is 64 BYTES: a longer one is refused by Apple, so it is
    // refused here instead (a bounded, alphabet-checked string).
    expect(pushCollapseIdOf("s1", "r1")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(pushCollapseIdOf("s1", "r1")).toBe(pushCollapseIdOf("s1", "r1"));
    expect(pushCollapseIdOf("s1", "r1")).not.toBe(pushCollapseIdOf("s1", "r2"));
    // Multi-byte and over-long parts never produce an invalid header value.
    expect(pushCollapseIdOf(EMOJI.repeat(40), EMOJI.repeat(40))).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
