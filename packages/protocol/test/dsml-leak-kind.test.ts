/**
 * docs/fix/deepseek-dsml-leak.md, Review MEDIUM-1: the "your reply was a tool
 * call as text, I am asking again" notice must reach an OLDER client as an
 * update it SKIPS, never as one it fails.
 *
 * The trap this pins: emitting it as a new value of `context_note.reason`
 * would make a v22 client see a KNOWN kind whose member fails its schema —
 * `malformed context_note update from the daemon`, an error mid-turn. A new
 * display KIND is free (AGENTS §7): the older client's union does not know the
 * tag, its catch-all parses the frame, and the class table says skip.
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWN_UPDATE_TYPES,
  PROTOCOL_VERSION,
  SessionUpdateOrUnknownSchema,
  SessionUpdateSchema,
  UPDATE_CLASS,
  UnknownSessionUpdateSchema,
  clientSupportsUpdate,
} from "../src/index.ts";

/** The notice's frame, exactly as the daemon emits it. */
const FRAME = { type: "dsml_leak", text: "use the tool-calling mechanism" };

describe("the DSML re-ask notice is its own display KIND (no enum value, no version bump)", () => {
  test("this build knows it: in the union, class display", () => {
    expect(SessionUpdateSchema.safeParse(FRAME).success).toBe(true);
    expect(UPDATE_CLASS.dsml_leak).toBe("display");
    expect(KNOWN_UPDATE_TYPES).toContain("dsml_leak");
  });

  test("`context_note` keeps an OLDER client's reason enum: no member was added", () => {
    // The pre-fix enum. An added member (`leaked_tool_call`) made a v22 client
    // report `malformed context_note` — exactly what this shape avoids.
    const olderReasons = ["continue", "background_exit", "hook"];
    for (const reason of olderReasons) {
      expect(
        SessionUpdateSchema.safeParse({ type: "context_note", text: "x", reason }).success,
      ).toBe(true);
    }
    expect(
      SessionUpdateSchema.safeParse({ type: "context_note", text: "x", reason: "leaked_tool_call" })
        .success,
    ).toBe(false);
  });

  test("an OLDER client does not know the tag, so it parses the frame and skips it", () => {
    const older = KNOWN_UPDATE_TYPES.filter((type) => type !== "dsml_leak");
    // Its known-tag set lacks it, and the frame carries no `mandatory` flag.
    expect(clientSupportsUpdate(older, "dsml_leak")).toBe(false);
    // Its catch-all still parses the frame — a skip, never a schema failure.
    expect(UnknownSessionUpdateSchema.safeParse(FRAME).success).toBe(true);
    expect(SessionUpdateOrUnknownSchema.safeParse(FRAME).success).toBe(true);
  });

  test("it is a display kind: nothing waits on it", () => {
    // Display only, so no bump by this kind (AGENTS §7). A FLOOR, not the exact
    // number: the number is assigned at merge (docs/feat/protocol-version-at-merge.md),
    // so this assertion must never need editing again. `dsml_leak` landed at 23.
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(23);
  });
});
