import { describe, expect, test } from "bun:test";
import { groupLabel, sessionRows, shortId } from "../src/labels.js";

describe("groupLabel (Chrome tab group title)", () => {
  test("a named session shows ONLY its name", () => {
    expect(groupLabel("Fix login", "0f3a9c1d-aaaa")).toBe("Fix login");
  });
  test("an unnamed session falls back to «tentacle» + short id", () => {
    expect(groupLabel("", "0f3a9c1d-aaaa")).toBe("tentacle 0f3a");
    expect(groupLabel("   ", "0f3a9c1d-aaaa")).toBe("tentacle 0f3a");
    expect(groupLabel(undefined, "0f3a9c1d-aaaa")).toBe("tentacle 0f3a");
  });
  test("a long name is cut with an ellipsis; control chars and runs of space collapse", () => {
    const l = groupLabel(`a\n\n  b${"x".repeat(100)}`, "u");
    expect(l.startsWith("a b")).toBe(true);
    expect(l.length).toBeLessThanOrEqual(40);
    expect(l.endsWith("…")).toBe(true);
  });
});

describe("shortId", () => {
  test("first 8 characters", () => expect(shortId("0f3a9c1d-aaaa-bbbb")).toBe("0f3a9c1d"));
  test("short ids stay whole", () => expect(shortId("abc")).toBe("abc"));
});

describe("sessionRows (popup list)", () => {
  test("name primary, short id secondary, unnamed flagged", () => {
    const rows = sessionRows([
      { uid: "0f3a9c1d-1", title: "Fix login" },
      { uid: "77aa0011-2", title: "" },
    ]);
    expect(rows).toEqual([
      { uid: "0f3a9c1d-1", name: "Fix login", id: "0f3a9c1d", unnamed: false },
      { uid: "77aa0011-2", name: "tentacle 77aa", id: "77aa0011", unnamed: true },
    ]);
  });
  test("ids that collide at 8 chars are lengthened until unique", () => {
    const rows = sessionRows([
      { uid: "0f3a9c1d-1", title: "a" },
      { uid: "0f3a9c1d-2", title: "b" },
      { uid: "ffffffff-3", title: "c" },
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows[0]?.id).toBe("0f3a9c1d-1");
    expect(rows[2]?.id).toBe("ffffffff");
  });
  test("untrusted input: non-array, non-string fields are ignored", () => {
    expect(sessionRows(undefined as never)).toEqual([]);
    const rows = sessionRows([{ uid: 5 }, { uid: "abcdefgh1", title: 7 }, null] as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unnamed).toBe(true);
  });
});

import { popupView } from "../src/labels.js";
describe("popupView", () => {
  test("unlinked wins, then empty, then list", () => {
    expect(popupView(false, [{}])).toBe("unlinked");
    expect(popupView(true, [])).toBe("empty");
    expect(popupView(true, [{}])).toBe("list");
  });
});
