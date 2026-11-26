import { describe, expect, test } from "bun:test";
import {
  type OperatorFileRead,
  createOperatorFiles,
  parseKillSwitch,
  parseTakedowns,
} from "../src/operator-files.ts";

const ID = "abcdefghijklmnop";
const KEY = "A".repeat(43);

describe("parseKillSwitch", () => {
  test("absent = off", () => {
    expect(parseKillSwitch({ kind: "absent" })).toEqual({ mode: "off", invalid: false });
  });

  test("publish and all, surrounding whitespace ignored", () => {
    expect(parseKillSwitch({ kind: "text", text: "publish" }).mode).toBe("publish");
    expect(parseKillSwitch({ kind: "text", text: "  publish\n" }).mode).toBe("publish");
    expect(parseKillSwitch({ kind: "text", text: "all\n" })).toEqual({
      mode: "all",
      invalid: false,
    });
  });

  test("garbage, empty or unreadable fails closed to all", () => {
    for (const text of ["", "\n", "off", "Publish", "publish all", "al"]) {
      expect(parseKillSwitch({ kind: "text", text })).toEqual({ mode: "all", invalid: true });
    }
    expect(parseKillSwitch({ kind: "error" })).toEqual({ mode: "all", invalid: true });
  });
});

describe("parseTakedowns", () => {
  test("both forms, comments and blanks", () => {
    const parsed = parseTakedowns(
      ["# a comment", "", `app ${ID} phishing page`, `  key ${KEY}   repeated abuse  `, "   "].join(
        "\n",
      ),
    );
    expect([...parsed.apps]).toEqual([[ID, "phishing page"]]);
    expect([...parsed.keys]).toEqual([[KEY, "repeated abuse"]]);
    expect(parsed.invalid).toEqual([]);
  });

  test("a bad line is reported by number while the rest applies", () => {
    const parsed = parseTakedowns(
      [
        "app nope reason",
        `app ${ID}`,
        `key ${ID} reason`,
        `url ${ID} reason`,
        `key ${"A".repeat(42)}B reason`,
        `app ${ID} real\r`,
      ].join("\n"),
    );
    expect(parsed.invalid).toEqual([1, 2, 3, 4, 5]);
    expect([...parsed.apps]).toEqual([[ID, "real"]]);
    expect(parsed.keys.size).toBe(0);
  });
});

describe("createOperatorFiles", () => {
  function setup() {
    const files: Record<string, OperatorFileRead> = {
      "kill-switch": { kind: "absent" },
      takedowns: { kind: "absent" },
    };
    const lines: string[] = [];
    let at = 0;
    let reads = 0;
    const operator = createOperatorFiles({
      read: (name) => {
        reads += 1;
        return files[name] ?? { kind: "absent" };
      },
      now: () => at,
      staleMs: 1000,
      log: (line) => lines.push(line),
    });
    return {
      files,
      lines,
      operator,
      advance: (ms: number) => {
        at += ms;
      },
      reads: () => reads,
    };
  }

  test("re-reads only past the staleness bound, and logs a change once", () => {
    const { files, lines, operator, advance, reads } = setup();
    expect(operator.current().kill).toBe("off");
    files["kill-switch"] = { kind: "text", text: "publish" };
    advance(999);
    expect(operator.current().kill).toBe("off");
    expect(reads()).toBe(2);
    advance(1);
    expect(operator.current().kill).toBe("publish");
    advance(1000);
    operator.current();
    expect(lines.filter((l) => l.startsWith("kill "))).toEqual(["kill publish"]);
  });

  test("an invalid line is logged with its number, once per content", () => {
    const { files, lines, operator, advance } = setup();
    files.takedowns = { kind: "text", text: `app ${ID} bad\nwhat` };
    expect(operator.current().takedowns.apps.get(ID)).toBe("bad");
    advance(2000);
    operator.current();
    expect(lines.filter((l) => l.startsWith("operator-file"))).toEqual([
      "operator-file takedowns line 2 invalid",
    ]);
  });

  test("an unreadable takedowns file keeps the last good entries", () => {
    const { files, lines, operator, advance } = setup();
    files.takedowns = { kind: "text", text: `key ${KEY} abuse` };
    operator.current();
    files.takedowns = { kind: "error" };
    advance(1000);
    expect(operator.current().takedowns.keys.get(KEY)).toBe("abuse");
    expect(lines).toContain("operator-file takedowns unreadable");
    files.takedowns = { kind: "absent" };
    advance(1000);
    expect(operator.current().takedowns.keys.size).toBe(0);
  });

  test("a garbled kill switch is all, with one log line", () => {
    const { files, lines, operator, advance } = setup();
    files["kill-switch"] = { kind: "text", text: "banana" };
    expect(operator.current().kill).toBe("all");
    advance(5000);
    operator.current();
    expect(lines.filter((l) => l.startsWith("operator-file kill-switch"))).toHaveLength(1);
    expect(lines).toContain("kill all");
  });
});
