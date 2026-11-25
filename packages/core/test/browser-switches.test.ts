import { describe, expect, test } from "bun:test";
import {
  BROWSER_ACTION_TOOL,
  BROWSER_DEFAULTS,
  CapabilityRefusal,
  NO_CAPABILITIES,
  type PermissionRequest,
  type SessionCapabilities,
  applyCapabilityOp,
  autoApproves,
  browserAutoAnswers,
  browserSwitchesOf,
  browserToolsEnabled,
} from "../src/index.ts";

// docs/feat/browser-inspect.md B5b: the browser switches' one rule, and who
// may answer a browser ask. Each test names the mutation that turns it red.

const op = (name: string, enabled: boolean) => ({ kind: "browser" as const, name, enabled });

describe("the browser op", () => {
  test("auto / clear set the non-default value; off restores it", () => {
    // Mutation: map `auto` to `secrets` → the table breaks.
    const auto = applyCapabilityOp(NO_CAPABILITIES, op("auto", true));
    expect(browserSwitchesOf(auto)).toEqual({ secrets: "masked", actions: "auto" });
    const both = applyCapabilityOp(auto, op("clear", true));
    expect(both.browser).toEqual({ secrets: "clear", actions: "auto" });
    const back = applyCapabilityOp(both, op("auto", false));
    expect(back.browser).toEqual({ secrets: "clear", actions: "ask" });
    // The disabled sets are untouched.
    expect(back.disabledTools).toEqual([]);
  });

  test("a no-op returns the SAME state (identity: no log, no emit)", () => {
    // Mutation: always build a new object → a re-sent set would flap every client.
    expect(applyCapabilityOp(NO_CAPABILITIES, op("auto", false))).toBe(NO_CAPABILITIES);
    expect(applyCapabilityOp(NO_CAPABILITIES, op("clear", false))).toBe(NO_CAPABILITIES);
    const on = applyCapabilityOp(NO_CAPABILITIES, op("clear", true));
    expect(applyCapabilityOp(on, op("clear", true))).toBe(on);
  });

  test("an unknown switch name is refused, state untouched", () => {
    expect(() => applyCapabilityOp(NO_CAPABILITIES, op("enabled", true))).toThrow(
      CapabilityRefusal,
    );
    expect(() => applyCapabilityOp(NO_CAPABILITIES, op("everything", true))).toThrow(
      /unknown browser switch/,
    );
  });

  test("absent = the safe defaults; `enabled` projects the browser tool group", () => {
    expect(browserSwitchesOf(NO_CAPABILITIES)).toBe(BROWSER_DEFAULTS);
    expect(BROWSER_DEFAULTS).toEqual({ secrets: "masked", actions: "ask" });
    expect(browserToolsEnabled(NO_CAPABILITIES)).toBe(true);
    const off = applyCapabilityOp(NO_CAPABILITIES, {
      kind: "tool",
      name: "browser",
      enabled: false,
    });
    expect(browserToolsEnabled(off)).toBe(false);
  });
});

describe("browserAutoAnswers", () => {
  const ask = (extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
    kind: "browser_action",
    tool: BROWSER_ACTION_TOOL,
    level: "ask",
    title: "Click",
    input: {},
    ...extra,
  });
  const auto: SessionCapabilities = {
    ...NO_CAPABILITIES,
    browser: { secrets: "masked", actions: "auto" },
  };

  test.each([
    ["eligible + auto", ask({ browserAuto: true }), auto, true],
    ["eligible + ask (the default)", ask({ browserAuto: true }), NO_CAPABILITIES, false],
    ["hard (no slack) + auto", ask(), auto, false],
    [
      "a tool ask carrying the slack + auto",
      { ...ask({ browserAuto: true }), kind: "tool" as const },
      auto,
      false,
    ],
    [
      "a hop carrying the slack + auto",
      { ...ask({ browserAuto: true }), kind: "session_hop" as const },
      auto,
      false,
    ],
  ])("%s", (_name, req, caps, want) => {
    // Mutation: drop any one conjunct of `browserAutoAnswers` → a row flips.
    expect(browserAutoAnswers(req, caps)).toBe(want);
  });

  test("the session's auto-accept still refuses a browser ask that carries the slack", () => {
    // Mutation: let `browserAuto` pass `autoApproves` (the `hopAuto` shape) → red.
    expect(autoApproves(ask({ browserAuto: true }), true)).toBe(false);
  });
});
