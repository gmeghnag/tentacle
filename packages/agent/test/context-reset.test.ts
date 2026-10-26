import { describe, expect, test } from "bun:test";
import { CONTEXT_RESET_HEADER, restartMessage, restartPromptOf } from "../src/index.ts";

// docs/feat/context-reset-barrier.md (slice 2): the restart message's marker.
// Display only: the TUI renders a reset from it (separator + "restart prompt"
// row) on every path — live, a resync, `--resume`. Never a decision input.

describe("restart message marker", () => {
  test("restartPromptOf round-trips restartMessage, multi-line prompts included", () => {
    for (const prompt of ["next: step 3", "goal\n\n- plan in docs/plan.md\n- done: 1, 2"]) {
      expect(restartPromptOf(restartMessage(prompt))).toBe(prompt);
    }
    expect(restartMessage("x").startsWith(CONTEXT_RESET_HEADER)).toBe(true);
  });

  test("ignores what follows the block (jobs, skills note, a usage line)", () => {
    const content = `${restartMessage("the prompt")}\n\nBackground jobs still running:\n- j1: \`sleep 9\`\ncontext: 5k / 128k tokens (4%)`;
    expect(restartPromptOf(content)).toBe("the prompt");
  });

  test("a prompt that quotes the closing tag keeps it (the LAST tag closes the block)", () => {
    const prompt = "write </restart_prompt> literally";
    expect(restartPromptOf(restartMessage(prompt))).toBe(prompt);
  });

  test("anything else is not a restart message", () => {
    for (const content of [
      "",
      "a plain user message",
      "Summary of the earlier conversation (compacted to save context):\n\nx",
      `${CONTEXT_RESET_HEADER}\nno block`,
      `quoted: ${restartMessage("p")}`,
    ]) {
      expect(restartPromptOf(content)).toBeNull();
    }
  });
});
