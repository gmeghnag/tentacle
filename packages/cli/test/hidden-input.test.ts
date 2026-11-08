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

  test("EOF resolves empty, so a caller never hangs on a closed terminal", async () => {
    const t = terminal();
    const answer = readHiddenLine("model.apiKey: ", { input: t.input, output: t.output });
    t.input.end();
    expect(await answer).toBe("");
  });
});
