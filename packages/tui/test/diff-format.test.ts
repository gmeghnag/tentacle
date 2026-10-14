import { describe, expect, test } from "bun:test";
import { parsePatch } from "../src/diff-format.ts";

describe("parsePatch", () => {
  test("classifies hunk, meta, add, del and context lines", () => {
    const patch = ["--- a", "+++ a", "@@ -1,2 +1,2 @@", " context", "-old", "+new", ""].join("\n");

    const lines = parsePatch(patch);
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "context", "del", "add"]);
    expect(lines.find((l) => l.kind === "add")?.text).toBe("+new");
  });

  test("does not treat +++/--- headers as add/del", () => {
    const lines = parsePatch("+++ b\n--- a\n+real");
    expect(lines[0]?.kind).toBe("meta");
    expect(lines[1]?.kind).toBe("meta");
    expect(lines[2]?.kind).toBe("add");
  });
});
