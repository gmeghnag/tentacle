import { describe, expect, test } from "bun:test";
import { replaceFailedWarning } from "../src/container-version.ts";
import { main } from "../src/index.ts";
import { UNTRUSTED_TEXT_MAX, untrustedText } from "../src/untrusted-text.ts";

// Text a container or a remote daemon wrote is untrusted (AGENTS §7): it must
// not reach the user's terminal or transcript with escape sequences.
const HOSTILE = "boom \u001b[2J\u001b]0;pwned\u0007 ok\r\nnext‮evil";
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/;

describe("untrustedText", () => {
  test("one line, no control or bidi characters, capped with an ellipsis", () => {
    expect(untrustedText(HOSTILE)).toBe("boom [2J ]0;pwned ok nextevil");
    const huge = untrustedText("x".repeat(10_240));
    expect(huge.length).toBe(UNTRUSTED_TEXT_MAX);
    expect(huge.endsWith("…")).toBe(true);
  });
});

describe("the failed-replacement warning (R2-1)", () => {
  test("a container's stderr is sanitised and capped inside the warning", () => {
    // Mutation: embed `cause` raw again → the control-character assertion fails.
    const warning = replaceFailedWarning({
      had: "0.2.0",
      expected: "0.3.0",
      cause: `${HOSTILE}${"y".repeat(10_240)}`,
      localBinary: false,
    });
    expect(warning).not.toMatch(CONTROL);
    expect(warning.length).toBeLessThan(UNTRUSTED_TEXT_MAX + 600);
    expect(warning).toContain("replacing it failed: boom [2J ]0;pwned ok nextevil");
  });
});

describe("daemon text printed before the TUI mounts (R2-2)", () => {
  test("`connect`'s error line carries no escape sequences, whatever the daemon says", async () => {
    // Mutation: print the message raw at main.ts (connect error) → ESC reaches `write`.
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const id = (JSON.parse(String(raw)) as { id: number }).id;
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32002, message: `${HOSTILE}${"z".repeat(10_240)}` },
            }),
          );
        },
      },
    });
    try {
      const out: string[] = [];
      const code = await main(["bun", "cli", "connect", `ws://127.0.0.1:${server.port}`], {
        write: (t) => out.push(t),
      });
      const text = out.join("");
      expect(code).toBe(1);
      expect(text).toContain("[connect error] ");
      // The line's own newlines are ours; the daemon's text has none left.
      expect(text.replace(/^\n|\n$/g, "")).not.toMatch(CONTROL);
      expect(text.length).toBeLessThan(UNTRUSTED_TEXT_MAX + 100);
    } finally {
      server.stop(true);
    }
  });
});
