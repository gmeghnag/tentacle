/**
 * `device/pair` on the wire (docs/feat/device-pairing.md 9c): the method, its
 * two schemas, the `PairingRefused` code, and the forward-compatibility rules
 * the rest of the protocol lives by — a strip schema (an unknown field is
 * dropped, never a refusal), a bounded name, and a reason a client can branch
 * on without knowing this build's list.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DevicePairParamsSchema,
  DevicePairResultSchema,
  DomainErrorCode,
  Method,
  PAIRING_REFUSED_REASONS,
  PROTOCOL_VERSION,
  PairingRefusedDataSchema,
  DevicePairParamsSchema as Params,
  RequestSchemas,
  isMethodName,
  isPairingRefusedReason,
} from "../src/index.ts";
import { PAIRING_CODE_LENGTH } from "../src/pairing.ts";

const CODE = "K7M2QX9AB3";

describe("the method is registered", () => {
  test("`device/pair` is a method with params and result schemas", () => {
    expect(Method.DevicePair).toBe("device/pair");
    expect(isMethodName("device/pair")).toBe(true);
    expect(RequestSchemas[Method.DevicePair].params).toBe(DevicePairParamsSchema);
    expect(RequestSchemas[Method.DevicePair].result).toBe(DevicePairResultSchema);
  });

  test("`PairingRefused` is -32017, past the existing domain codes", () => {
    expect(DomainErrorCode.PairingRefused).toBe(-32017);
    expect(DomainErrorCode.AttachmentRefused).toBe(-32016);
    // Additive: the number did NOT move (an older daemon simply has no /e2e).
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(24);
  });
});

describe("params", () => {
  test("a code of the right length plus a printable name", () => {
    expect(Params.safeParse({ code: CODE, name: "iPhone di Gabriel" }).success).toBe(true);
  });

  test("the code's length is pinned to the payload's own constant", () => {
    expect(PAIRING_CODE_LENGTH).toBe(10);
    expect(Params.safeParse({ code: "SHORT", name: "iPhone" }).success).toBe(false);
    expect(Params.safeParse({ code: `${CODE}0`, name: "iPhone" }).success).toBe(false);
  });

  test("a name with control characters is refused (F17: no ANSI reaches a terminal)", () => {
    expect(Params.safeParse({ code: CODE, name: "iPhone\u001b[2J" }).success).toBe(false);
    expect(Params.safeParse({ code: CODE, name: "iPhone\u0007" }).success).toBe(false);
    // A bidi override is NOT a control character by the C0/C1 rule: it is
    // stripped for display by `untrustedText` (`oneLine`, which drops U+202A-
    // U+202E), so the schema's job is the control-character gate and the
    // terminal's is the bidi one. Both ends are pinned: this test's first two
    // lines here, and `oneLine`'s own suite in the TUI package.
    expect(Params.safeParse({ code: CODE, name: "iPhone\u202e" }).success).toBe(true);
    expect(Params.safeParse({ code: CODE, name: "" }).success).toBe(false);
    expect(Params.safeParse({ code: CODE, name: "x".repeat(65) }).success).toBe(false);
    expect(Params.safeParse({ code: CODE, name: "x".repeat(64) }).success).toBe(true);
  });

  test("an unknown field is DROPPED, never a refusal (AGENTS §7 forward compat)", () => {
    // This is also the F18 guard at the schema level: there is no key field,
    // so a peer's `publicKey`/`deviceKey` cannot survive the parse — the
    // handler's only key is the channel's `remoteStatic`.
    const parsed = Params.safeParse({
      code: CODE,
      name: "iPhone",
      publicKey: "AAAA",
      deviceKey: "deadbeef",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data).sort()).toEqual(["code", "name"]);
    expect(Object.hasOwn(parsed.data, "publicKey")).toBe(false);
  });

  test("a missing field is a refusal (the required ones are required)", () => {
    expect(Params.safeParse({ code: CODE }).success).toBe(false);
    expect(Params.safeParse({ name: "iPhone" }).success).toBe(false);
  });
});

describe("result", () => {
  test("a device id and the computer that accepted it", () => {
    const parsed = DevicePairResultSchema.safeParse({
      deviceId: "0123456789abcdef",
      computer: { id: "fedcba9876543210", name: "gabriel-mac" },
    });
    expect(parsed.success).toBe(true);
  });

  test("an id must be the 16-hex prefix of a key's digest", () => {
    const base = { computer: { id: "fedcba9876543210", name: "gabriel-mac" } };
    expect(
      DevicePairResultSchema.safeParse({ ...base, deviceId: "0123456789ABCDEF" }).success,
    ).toBe(false);
    expect(DevicePairResultSchema.safeParse({ ...base, deviceId: "0123456789abcde" }).success).toBe(
      false,
    );
    expect(DevicePairResultSchema.safeParse({ deviceId: "0123456789abcdef" }).success).toBe(false);
  });

  test("an unknown field in the result is dropped (a newer daemon's addition)", () => {
    const parsed = DevicePairResultSchema.safeParse({
      deviceId: "0123456789abcdef",
      computer: { id: "fedcba9876543210", name: "gabriel-mac", extra: 1 },
      pairedAt: 5,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("per-project pairing (docs/feat/mobile-projects.md §4, additive)", () => {
  const RESULT = {
    deviceId: "0123456789abcdef",
    computer: { id: "fedcba9876543210", name: "gabriel-mac" },
  };
  const PROJECT = { key: "assistant-0123456789ab", cwd: "/u/assistant", label: "assistant" };

  test("params carry `perProject: true`; an absent flag still parses (an older app)", () => {
    const parsed = Params.safeParse({ code: CODE, name: "iPhone", perProject: true });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.perProject).toBe(true);
    const old = Params.safeParse({ code: CODE, name: "iPhone" });
    expect(old.success).toBe(true);
    if (!old.success) return;
    expect(old.data.perProject).toBeUndefined();
  });

  test("the result carries the project; without it, it still parses (an older daemon)", () => {
    const parsed = DevicePairResultSchema.safeParse({ ...RESULT, project: PROJECT });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.project).toEqual(PROJECT);
    expect(DevicePairResultSchema.safeParse(RESULT).success).toBe(true);
  });

  test("an older result schema (a copy without `project`) STRIPS it, never refuses", () => {
    const older = z.object({ deviceId: z.string(), computer: z.object({ id: z.string() }) });
    const parsed = older.safeParse({ ...RESULT, project: PROJECT });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.hasOwn(parsed.data, "project")).toBe(false);
  });

  test("a project label or cwd with a control character is refused; bounds hold", () => {
    const bad = (project: object) =>
      DevicePairResultSchema.safeParse({ ...RESULT, project }).success;
    expect(bad({ ...PROJECT, label: "a\u001b[2J" })).toBe(false);
    expect(bad({ ...PROJECT, cwd: "/u/\u0007" })).toBe(false);
    expect(bad({ ...PROJECT, label: "x".repeat(65) })).toBe(false);
    expect(bad({ ...PROJECT, key: "k".repeat(129) })).toBe(false);
    expect(bad({ ...PROJECT, key: "" })).toBe(false);
  });

  test("`update_app` is a known reason (an older app reads it as a generic refusal)", () => {
    expect(isPairingRefusedReason("update_app")).toBe(true);
  });
});

describe("the refusal reasons", () => {
  test("every reason the plan names is known", () => {
    expect([...PAIRING_REFUSED_REASONS].sort()).toEqual([
      "already_paired",
      "declined",
      "invalid_code",
      "timeout",
      "too_many_attempts",
      "update_app",
      "used",
    ]);
    for (const reason of PAIRING_REFUSED_REASONS) {
      expect(isPairingRefusedReason(reason)).toBe(true);
    }
  });

  test("an unknown reason is NOT one of ours (a client reads it as generic)", () => {
    expect(isPairingRefusedReason("some_future_reason")).toBe(false);
    expect(isPairingRefusedReason(7)).toBe(false);
    expect(isPairingRefusedReason(undefined)).toBe(false);
  });

  test("`data.reason` is a bounded free string, so a newer reason parses", () => {
    expect(PairingRefusedDataSchema.safeParse({ reason: "invalid_code" }).success).toBe(true);
    // The forward-compatible half: an unknown reason is a VALID payload.
    expect(PairingRefusedDataSchema.safeParse({ reason: "some_future_reason" }).success).toBe(true);
    expect(PairingRefusedDataSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(PairingRefusedDataSchema.safeParse({ reason: "x".repeat(65) }).success).toBe(false);
    expect(PairingRefusedDataSchema.safeParse({}).success).toBe(false);
  });
});
