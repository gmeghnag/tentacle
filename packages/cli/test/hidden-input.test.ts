import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readHiddenLine } from "../src/hidden-input.ts";

/** A fake terminal: `type` its stdin, read what it wrote to the screen. */
function terminal(): { input: PassThrough; output: PassThrough; screen: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return { input, output, screen: () => chunks.join("") };
}

describe("readHiddenLine", () => {
  test("shows the prompt, echoes nothing, returns the line", async () => {
    // Mutation: `rl._writeToOutput = () => undefined` removed → the screen holds
    // the typed value, which is exactly the leak this exists to prevent.
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.write("sk-live-9f2\n");
    expect(await answer).toBe("sk-live-9f2");
    expect(t.screen()).toContain("model.apiKey: ");
    expect(t.screen()).not.toContain("sk-live-9f2");
    // A newline is emitted so the next line of output starts clean.
    expect(t.screen().endsWith("\n")).toBe(true);
  });
  test("an empty answer is an empty string, not a hang", async () => {
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.write("\n");
    expect(await answer).toBe("");
  });

  test("EOF is a CANCEL, so a caller never hangs on a closed terminal", async () => {
    // LOW-7: `undefined`, not `""` — an aborted prompt must not be answered with
    // the schema's "an empty value is not a setting" (see the LOW-7 tests below).
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.end();
    expect(await answer).toBeUndefined();
  });
});

describe("LOW-7: an interruption is a cancellation, not an empty value", () => {
  test('Ctrl+C resolves undefined (never "")', async () => {
    // `""` would run on into the schema and report "empty value … use unset",
    // which is a misleading answer to a deliberate cancel.
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.write("\u0003");
    expect(await answer).toBeUndefined();
  });

  test("EOF resolves undefined too (a closed terminal is not an empty answer)", async () => {
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.end();
    expect(await answer).toBeUndefined();
  });

  test('an empty line is still "" (the schema\'s message is the right one there)', async () => {
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.write("\n");
    expect(await answer).toBe("");
  });

  test("a cancelled prompt leaves the screen clean and still emits the newline", async () => {
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.write("\u0003");
    await answer;
    expect(t.screen()).not.toContain("sk-");
    expect(t.screen().endsWith("\n")).toBe(true);
  });
});
