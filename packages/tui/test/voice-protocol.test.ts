import { describe, expect, test } from "bun:test";
import {
  MAX_LINE_BYTES,
  decodeHelperLine,
  encodeHelperLine,
  helperError,
  helperFinal,
  helperReady,
  parseCommandLine,
  parseHelperLine,
  startCommand,
  stopCommand,
} from "../src/voice-protocol.ts";

describe("T1 voice-protocol: a line round-trips", () => {
  test("every message the TUI sends round-trips through the encoder and parser", () => {
    for (const msg of [
      startCommand(1, "auto"),
      startCommand(2, "it"),
      { t: "turn", id: 3 },
      stopCommand(4),
      { t: "cancel", id: 5 },
    ] as const) {
      const line = encodeHelperLine(msg);
      expect(line.endsWith("\n")).toBe(true);
      const back = parseCommandLine(line);
      expect(back).toEqual({ ok: true, message: msg });
    }
  });

  test("a newline inside a field cannot break the framing (one line per message)", () => {
    const line = encodeHelperLine(helperFinal({ id: 1, text: "a\nb", lang: "it" }));
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    const back = parseHelperLine(line);
    expect(back?.ok).toBe(true);
    if (back?.ok === true && back.message.t === "final") {
      expect(back.message.text).toBe("a\nb");
    }
  });
});

describe("T1 voice-protocol: the line cap", () => {
  test("a line over the cap is a protocol error, not a throw", () => {
    const huge = `${JSON.stringify({ t: "partial", id: 1, text: "x".repeat(MAX_LINE_BYTES) })}\n`;
    const back = parseHelperLine(huge);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("line_too_long");
  });

  test("the cap is measured in UTF-8 bytes, not characters", () => {
    // Half the budget in 4-byte characters is over it.
    const text = "😀".repeat(Math.ceil(MAX_LINE_BYTES / 4));
    const back = parseHelperLine(`${JSON.stringify({ t: "partial", id: 1, text })}\n`);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("line_too_long");
  });

  test("exactly the cap is still accepted", () => {
    const head = JSON.stringify({ t: "partial", id: 1, text: "" });
    const pad = MAX_LINE_BYTES - head.length;
    const line = `${head.slice(0, -2)}${"y".repeat(pad)}"}`;
    expect(Buffer.byteLength(line, "utf8")).toBe(MAX_LINE_BYTES);
    expect(parseHelperLine(line)?.ok).toBe(true);
  });
});

describe("T1 voice-protocol: the version handshake", () => {
  test("a ready line with the TUI's version is accepted", () => {
    const back = parseHelperLine(encodeHelperLine(helperReady({ v: 1, engine: "apple" })));
    expect(back).toEqual({
      ok: true,
      message: { t: "ready", v: 1, engine: "apple", device: "" },
    });
  });

  test("a ready line with another version is refused with both versions named", () => {
    const back = parseHelperLine(`${JSON.stringify({ t: "ready", v: 99, engine: "apple" })}\n`);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) {
      expect(back.error.code).toBe("version_mismatch");
      expect(back.error.message).toContain("99");
      expect(back.error.message).toContain("1");
    }
  });

  test("a message other than `ready` may not carry a version at all", () => {
    // Version skew is decided once, on the first line: a later line claiming a
    // version would mean the pair half-works, which the design forbids.
    const back = parseHelperLine(`${JSON.stringify({ t: "listening", id: 1, v: 2 })}\n`);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("bad_request");
  });
});

describe("T1 voice-protocol: malformed input never throws", () => {
  test("broken JSON is an error value", () => {
    const back = parseHelperLine('{"t": "ready"\n');
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("bad_request");
  });

  test("an unknown message type is an error value", () => {
    const back = parseHelperLine(`${JSON.stringify({ t: "wat" })}\n`);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("bad_request");
  });

  test("a known type with a missing field is an error value", () => {
    const back = parseHelperLine(`${JSON.stringify({ t: "final" })}\n`);
    expect(back?.ok).toBe(false);
    if (back !== null && !back.ok) expect(back.error.code).toBe("bad_request");
  });

  test("a JSON array or a bare scalar on the stream is an error value", () => {
    for (const line of ["[]", "42", "null", '"hi"']) {
      const back = parseHelperLine(`${line}\n`);
      expect(back?.ok).toBe(false);
    }
  });

  test("blank lines and trailing whitespace are tolerated", () => {
    expect(parseHelperLine("\n")).toBe(null);
    expect(parseHelperLine("  \t\n")).toBe(null);
    const back = parseHelperLine(`${JSON.stringify({ t: "level", id: 1, dbfs: -31 })}\r\n`);
    expect(back).toEqual({ ok: true, message: { t: "level", id: 1, dbfs: -31 } });
  });

  test("an error line from the helper parses, code and all", () => {
    const back = parseHelperLine(
      encodeHelperLine(helperError({ code: "mic_denied", message: "no mic" })),
    );
    expect(back).toEqual({
      ok: true,
      message: { t: "error", code: "mic_denied", message: "no mic" },
    });
  });

  test("a known error code survives; an unknown one is kept as-is (forward compat)", () => {
    const back = parseHelperLine(
      encodeHelperLine(helperError({ code: "route_lost", message: "" })),
    );
    expect(back?.ok).toBe(true);
    const ahead = parseHelperLine(
      `${JSON.stringify({ t: "error", code: "some_future_code", message: "hi" })}\n`,
    );
    expect(ahead?.ok).toBe(true);
    if (ahead?.ok === true && ahead.message.t === "error") {
      expect(ahead.message.code).toBe("some_future_code");
    }
  });
});

describe("T1 voice-protocol: helpers build the wire shapes", () => {
  test("start carries the id and the language", () => {
    expect(startCommand(7, "en")).toEqual({ t: "start", id: 7, lang: "en" });
    const back = parseCommandLine(encodeHelperLine(stopCommand(7)));
    expect(back).toEqual({ ok: true, message: { t: "stop", id: 7 } });
  });
});
