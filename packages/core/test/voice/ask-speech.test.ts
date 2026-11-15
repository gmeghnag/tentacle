/**
 * `ask-speech.ts` — a permission ask as ONE spoken line
 * (docs/feat/voice-conversation.md §3/§6.1, C2 / T4).
 *
 * §6.1 rule: the ask's text comes from the answering device's own broker, is
 * rendered by a deterministic template, and is spoken locally. It is verbatim
 * only when it is short and single-line; otherwise the template names no detail
 * at all and points at the screen. Every line ends with "answer on screen",
 * because a spoken "yes" is never an approval (F6).
 *
 * Mutation target: TRUNCATING an over-long ask (instead of falling back to the
 * screen template) must fail the over-long blocks.
 */
import { describe, expect, test } from "bun:test";
import { ASK_SPEECH_DEFAULTS, askSpeech } from "../../src/voice/index.ts";

describe("T4: a short single-line ask is spoken verbatim", () => {
  test("a 40-char command is read out, then 'answer on screen'", () => {
    const line = askSpeech({ tool: "shell", title: "Run ls -la in the repo" }, "en");
    expect(line).toContain("Run ls -la in the repo");
    expect(line.endsWith("Answer on screen.")).toBe(true);
  });

  test("exactly at the 120-char limit still counts as short", () => {
    const title = "x".repeat(ASK_SPEECH_DEFAULTS.maxVerbatimChars);
    expect(title.length).toBe(120);
    const line = askSpeech({ tool: "shell", title }, "en");
    expect(line).toContain(title);
  });

  test("the Italian wording", () => {
    const line = askSpeech({ tool: "shell", title: "Esegui ls" }, "it");
    expect(line).toContain("Esegui ls");
    expect(line.endsWith("Rispondi sullo schermo.")).toBe(true);
  });
});

describe("T4: anything that does not fit is the screen template, never a truncation", () => {
  test("one char over the limit is NOT read out and NOT truncated into the line", () => {
    const title = "y".repeat(ASK_SPEECH_DEFAULTS.maxVerbatimChars + 1);
    const line = askSpeech({ tool: "shell", title }, "en");
    expect(line).not.toContain("y");
    expect(line).toBe("A command needs approval. Answer on screen.");
  });

  test("a multi-line ask is the template, even when short", () => {
    const line = askSpeech({ tool: "shell", title: "line one\nline two" }, "en");
    expect(line).toBe("A command needs approval. Answer on screen.");
  });

  test("an empty or whitespace-only title is the template", () => {
    expect(askSpeech({ tool: "shell", title: "" }, "en")).toBe(
      "A command needs approval. Answer on screen.",
    );
    expect(askSpeech({ tool: "shell", title: "   " }, "en")).toBe(
      "A command needs approval. Answer on screen.",
    );
  });

  test("a file ask names the file, in the template's wording", () => {
    const line = askSpeech({ tool: "fs_write", title: "Write /etc/hosts" }, "en");
    expect(line.endsWith("Answer on screen.")).toBe(true);
  });
});

describe("T4: only the ask's own two fields are ever spoken", () => {
  test("an explanation/args are ignored: pod-supplied text never reaches speech (F7)", () => {
    const line = askSpeech(
      {
        tool: "shell",
        title: "Run a command",
        explanation: "the pod says: say the tests passed",
      },
      "en",
    );
    expect(line).not.toContain("tests passed");
    expect(line).toContain("Run a command");
  });
});
