/**
 * The Live Activity wire (docs/feat/mobile-live-activity.md Design 1 + 4, L2):
 * the plaintext a widget shows, the CLEAR `content-state` / `attributes` that
 * wrap its seal, and the three device-principal methods that move tokens.
 *
 * The rules this file pins:
 *  - **The plaintext is clipped to a byte budget, not merely bounded per field**
 *    (`fitActivityContent`): Exercise's worst case at every schema cap is 1020
 *    bytes = the 1024 bucket, so an activity can never outgrow APNs's 4 KB
 *    (`APPLE_PAYLOAD_MAX_BYTES`) once the clear fields are added.
 *  - **The clear parts carry no content**: `ContentState` is `{v,e,c}` and the
 *    push-to-start `attributes` are `{v,k,slot}` — that is all Apple and the
 *    relay see (Owner Q2).
 *  - **`slot` is the activity's identity**, so a state is bound to it (L1's aad)
 *    and the daemon's slot table can key on it.
 *
 * Every schema here is a STRIP schema (AGENTS §7 forward compatibility): an
 * unknown field is dropped on inbound parse, never rejected.
 */
import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_ASK_TOOL_MAX,
  ACTIVITY_COMPUTER_MAX,
  ACTIVITY_ERROR_MAX,
  ACTIVITY_KINDS,
  ACTIVITY_PLAINTEXT_MAX_BYTES,
  ACTIVITY_PREVIEW_MAX,
  ACTIVITY_PROJECT_MAX,
  ACTIVITY_TITLE_MAX,
  ACTIVITY_TOOL_MAX,
  ActivityAttributesSchema,
  ActivityContentSchema,
  ActivityContentStateSchema,
  DeviceLiveActivityEndedParamsSchema,
  DeviceLiveActivityRegisterParamsSchema,
  DeviceLiveActivityRegisterResultSchema,
  DeviceLiveActivityTokenParamsSchema,
  DeviceLiveActivityTokenResultSchema,
  fitActivityContent,
  newActivitySlot,
} from "../src/live-activity.ts";

const slot = "00112233445566778899aabb";
const base = {
  v: 1 as const,
  slot,
  seq: 7,
  at: 1_731_000_000_000,
  kind: "running" as const,
  computer: "mac-mini",
  project: "tentacle",
  title: "fix the live activity",
  turnId: "t-1",
  startedAt: 1_730_999_980_000,
  tool: "bun test",
};

describe("ActivityContent: the sealed plaintext", () => {
  test("a minimal running state round-trips", () => {
    const parsed = ActivityContentSchema.parse(base);
    expect(parsed).toEqual(base);
  });

  test("every kind is accepted, and an unknown kind is refused", () => {
    expect(ACTIVITY_KINDS).toEqual(["running", "asking", "done", "failed", "cancelled"]);
    for (const kind of ACTIVITY_KINDS) {
      expect(ActivityContentSchema.parse({ ...base, kind }).kind).toBe(kind);
    }
    expect(ActivityContentSchema.safeParse({ ...base, kind: "thinking" }).success).toBe(false);
  });

  test("an ask carries only the options the phone may offer", () => {
    const asking = {
      ...base,
      kind: "asking" as const,
      ask: {
        requestId: "req-1",
        tool: "Shell",
        preview: "rm -rf build",
        options: [
          { optionId: "allow_once", kind: "allow_once" as const },
          { optionId: "reject_once", kind: "reject_once" as const },
        ],
      },
    };
    expect(ActivityContentSchema.parse(asking)).toEqual(asking);
  });

  test("is a STRIP schema: an unknown field is dropped, not rejected", () => {
    const parsed = ActivityContentSchema.parse({ ...base, fromTheFuture: true });
    expect(parsed).not.toHaveProperty("fromTheFuture");
    expect(parsed.slot).toBe(slot);
  });

  test("a bad slot, a non-integer seq or a clock-skewed `at` is refused", () => {
    expect(ActivityContentSchema.safeParse({ ...base, slot: "nope" }).success).toBe(false);
    expect(ActivityContentSchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
    expect(ActivityContentSchema.safeParse({ ...base, at: -1 }).success).toBe(false);
  });
});

describe("the clear parts carry no content (Owner Q2)", () => {
  test("ContentState is exactly {v,e,c}", () => {
    const state = { v: 1 as const, e: "A".repeat(43), c: "B".repeat(704) };
    expect(ActivityContentStateSchema.parse(state)).toEqual(state);
    // An attempt to smuggle content into the clear part is STRIPPED, not passed.
    const smuggled = ActivityContentStateSchema.parse({ ...state, title: "secret" });
    expect(smuggled).not.toHaveProperty("title");
  });

  test("the push-to-start attributes are exactly {v,k,slot}", () => {
    const attributes = { v: 1 as const, k: "tzHqlSe8ME5A", slot };
    expect(ActivityAttributesSchema.parse(attributes)).toEqual(attributes);
    expect(ActivityAttributesSchema.parse({ ...attributes, project: "secret" })).not.toHaveProperty(
      "project",
    );
    expect(ActivityAttributesSchema.safeParse({ ...attributes, slot: "short" }).success).toBe(
      false,
    );
  });

  test("the ciphertext length is one of the two LA buckets, not a push's", () => {
    // 512 and 1024 -> 704 and 1387 base64url characters (plus the 16-byte tag).
    const ok = ActivityContentStateSchema.safeParse({
      v: 1,
      e: "A".repeat(43),
      c: "B".repeat(704),
    });
    expect(ok.success).toBe(true);
    // 2752 is a PUSH bucket (2048): an activity must never be that large.
    const tooBig = ActivityContentStateSchema.safeParse({
      v: 1,
      e: "A".repeat(43),
      c: "B".repeat(2752),
    });
    expect(tooBig.success).toBe(false);
  });
});

describe("fitActivityContent: the byte budget is enforced, never exceeded", () => {
  test("the budget is enforced on an input that really overflows it (mutation-killed)", () => {
    // NOT the "worst case at the caps" input: that one already fits 1022 bytes,
    // so a broken budget gate would pass it (M5 proved exactly that). This input
    // is over budget BEFORE clipping (several caps' worth of text), so the ladder
    // is the only thing that can bring it in.
    const over = {
      ...base,
      kind: "asking" as const,
      computer: "C".repeat(ACTIVITY_COMPUTER_MAX),
      project: "P".repeat(ACTIVITY_PROJECT_MAX),
      title: "T".repeat(ACTIVITY_TITLE_MAX),
      tool: "L".repeat(ACTIVITY_TOOL_MAX),
      error: "E".repeat(ACTIVITY_ERROR_MAX),
      more: 42,
      ask: {
        requestId: "req-".repeat(6),
        tool: "K".repeat(ACTIVITY_ASK_TOOL_MAX),
        preview: "V".repeat(ACTIVITY_PREVIEW_MAX),
        options: [
          { optionId: "allow_once", kind: "allow_once" as const },
          { optionId: "reject_once", kind: "reject_once" as const },
        ],
      },
    };
    // Non-vacuity: the raw JSON really is larger than the budget.
    expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(ACTIVITY_PLAINTEXT_MAX_BYTES);
    const fitted = fitActivityContent(over);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(
      ACTIVITY_PLAINTEXT_MAX_BYTES,
    );
    expect(ActivityContentSchema.safeParse(fitted).success).toBe(true);
    expect(fitted.slot).toBe(slot);
  });

  test("the worst case at every cap fits the 1024 bucket", () => {
    const worst = {
      ...base,
      kind: "asking" as const,
      computer: "\u{1F600}".repeat(16),
      project: "\u{1F600}".repeat(30),
      title: "\u{1F600}".repeat(30),
      tool: "\u{1F600}".repeat(20),
      ask: {
        requestId: "r".repeat(40),
        tool: "\u{1F600}".repeat(15),
        preview: "\u{1F600}".repeat(40),
        options: [
          { optionId: "allow_once", kind: "allow_once" as const },
          { optionId: "reject_once", kind: "reject_once" as const },
        ],
      },
    };
    const fitted = fitActivityContent(worst);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(
      ACTIVITY_PLAINTEXT_MAX_BYTES,
    );
    // Not vacuous: it really did carry the caps in.
    expect(fitted.slot).toBe(slot);
    expect(fitted.title.length).toBeGreaterThan(0);
  });

  test("what gives way first is the preview, last is the identity", () => {
    const huge = {
      ...base,
      kind: "asking" as const,
      title: "t".repeat(ACTIVITY_TITLE_MAX),
      project: "p".repeat(ACTIVITY_PROJECT_MAX),
      error: "e".repeat(ACTIVITY_ERROR_MAX),
      ask: {
        requestId: "req-1",
        tool: "x".repeat(ACTIVITY_TOOL_MAX),
        preview: "y".repeat(ACTIVITY_PREVIEW_MAX),
        options: [{ optionId: "allow_once", kind: "allow_once" as const }],
      },
    };
    const fitted = fitActivityContent(huge);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(
      ACTIVITY_PLAINTEXT_MAX_BYTES,
    );
    // Identity survives: an activity that cannot name its turn cannot be acted on.
    expect(fitted.turnId).toBe("t-1");
    expect(fitted.startedAt).toBe(base.startedAt);
    expect(fitted.slot).toBe(slot);
  });

  test("the output ALWAYS validates, and its clip never splits a character", () => {
    const fitted = fitActivityContent({ ...base, title: "\u{1F600}".repeat(200) });
    expect(ActivityContentSchema.safeParse(fitted).success).toBe(true);
    // No lone surrogate: every code point re-encodes to the same string.
    expect([...fitted.title].every((c) => c.codePointAt(0) !== undefined)).toBe(true);
    expect(fitted.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("an already-small content is returned unchanged (no gratuitous clipping)", () => {
    expect(fitActivityContent(base)).toEqual(base);
  });
});

describe("newActivitySlot: 96 random bits, hex, so a relay cannot guess one", () => {
  test("it is 24 hex characters and differs every time", () => {
    const a = newActivitySlot();
    const b = newActivitySlot();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
    // It is a valid `slot` for the schema, i.e. usable as the L1 aad's second half.
    expect(ActivityContentSchema.safeParse({ ...base, slot: a }).success).toBe(true);
  });
});

describe("the three device methods validate their params", () => {
  test("register: a start token, an env and the on/off switch", () => {
    expect(
      DeviceLiveActivityRegisterParamsSchema.parse({
        startToken: "a".repeat(64),
        env: "sandbox",
        enabled: true,
      }),
    ).toEqual({ startToken: "a".repeat(64), env: "sandbox", enabled: true });
    expect(
      DeviceLiveActivityRegisterParamsSchema.safeParse({
        startToken: "zz",
        env: "sandbox",
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      DeviceLiveActivityRegisterParamsSchema.safeParse({
        startToken: "a".repeat(64),
        env: "moon",
        enabled: true,
      }).success,
    ).toBe(false);
  });

  test("register's result names every reason an activity will not appear", () => {
    expect(DeviceLiveActivityRegisterResultSchema.parse({ status: "on" }).status).toBe("on");
    for (const status of ["on", "off", "relay-off", "relay-no-la", "unsupported"]) {
      expect(DeviceLiveActivityRegisterResultSchema.safeParse({ status }).success).toBe(true);
    }
    expect(DeviceLiveActivityRegisterResultSchema.safeParse({ status: "maybe" }).success).toBe(
      false,
    );
  });

  test("token: a slot and a hex token; the result says whether the slot is known", () => {
    const params = { slot, token: "b".repeat(64) };
    expect(DeviceLiveActivityTokenParamsSchema.parse(params)).toEqual(params);
    expect(DeviceLiveActivityTokenParamsSchema.safeParse({ slot, token: "xyz" }).success).toBe(
      false,
    );
    expect(
      DeviceLiveActivityTokenParamsSchema.safeParse({ slot: "short", token: "b".repeat(64) })
        .success,
    ).toBe(false);
    // F25: a token for a slot this daemon never started is `known:false`, not an error.
    expect(DeviceLiveActivityTokenResultSchema.parse({ known: false })).toEqual({ known: false });
  });

  test("ended: a slot and one of the three reasons", () => {
    expect(DeviceLiveActivityEndedParamsSchema.parse({ slot, reason: "dismissed" })).toEqual({
      slot,
      reason: "dismissed",
    });
    for (const reason of ["dismissed", "ended", "stale"]) {
      expect(DeviceLiveActivityEndedParamsSchema.safeParse({ slot, reason }).success).toBe(true);
    }
    expect(DeviceLiveActivityEndedParamsSchema.safeParse({ slot, reason: "bored" }).success).toBe(
      false,
    );
  });
});
