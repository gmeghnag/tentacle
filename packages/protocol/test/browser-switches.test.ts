import { describe, expect, test } from "bun:test";
import {
  BrowserStatusResultSchema,
  LogCapabilitiesEntrySchema,
  Method,
  RequestSchemas,
  SessionCapabilitiesSchema,
  SetCapabilityParamsSchema,
} from "../src/index.ts";

// docs/feat/browser-inspect.md B5b: additive wire for the browser switches.

describe("capabilities.browser", () => {
  const base = { disabledMcp: [], disabledSkills: [], disabledTools: [] };
  const browser = { enabled: true, secrets: "clear", actions: "auto" } as const;

  test("accepted when present; absent still parses (an older daemon / log)", () => {
    expect(SessionCapabilitiesSchema.parse({ ...base, browser })).toEqual({ ...base, browser });
    expect(SessionCapabilitiesSchema.parse(base)).toEqual(base);
  });

  test("an unknown enum value is refused (a future value needs a protocol.d note)", () => {
    expect(
      SessionCapabilitiesSchema.safeParse({ ...base, browser: { ...browser, actions: "yolo" } })
        .success,
    ).toBe(false);
  });

  test("a `capabilities` log entry with and without `browser` parses", () => {
    // The entry's own payload schema (the envelope is not under test here).
    const payload = LogCapabilitiesEntrySchema.shape.capabilities;
    expect(payload.parse(base)).toEqual(base);
    expect(payload.parse({ ...base, browser })).toEqual({ ...base, browser });
  });

  test("set_capability takes kind `browser`", () => {
    expect(
      SetCapabilityParamsSchema.safeParse({
        sessionId: "s1",
        kind: "browser",
        name: "auto",
        enabled: true,
      }).success,
    ).toBe(true);
  });
});

describe("browser/status", () => {
  test("registered with its schemas", () => {
    expect(Method.BrowserStatus).toBe("browser/status");
    expect(RequestSchemas[Method.BrowserStatus].result).toBe(BrowserStatusResultSchema);
  });

  test("the smallest answer (a pod) and a full one parse; >64 tabs are refused", () => {
    expect(BrowserStatusResultSchema.safeParse({ available: false, tabs: [] }).success).toBe(true);
    const tab = { id: 1, title: "t", where: "example.com/a", handedOver: false, traced: true };
    expect(
      BrowserStatusResultSchema.safeParse({
        available: true,
        link: { state: "connected", managed: false },
        heldElsewhere: false,
        tabs: [tab],
      }).success,
    ).toBe(true);
    expect(
      BrowserStatusResultSchema.safeParse({
        available: true,
        tabs: Array.from({ length: 65 }, (_, i) => ({ ...tab, id: i })),
      }).success,
    ).toBe(false);
  });
});
