import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@tentacle/core";
import {
  CONTEXT_RESET_HEADER,
  type CarriedSkill,
  contextResetHistory,
  offeredSkillNames,
  resetRefusal,
  restartMessage,
  restartPromptOf,
  skillSetDelta,
} from "../src/index.ts";

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

// docs/feat/context-reset.md (slice 3): the pure pieces of the reset.

const skillCall = (id: string, name: string): ToolCall => ({
  id,
  name: "skill",
  arguments: JSON.stringify({ name }),
});
const carried = (name: string, source: CarriedSkill["source"] = "fresh"): CarriedSkill => ({
  name,
  call: skillCall(`c-${name}`, name),
  content: `<skill_content name="${name}">\nbody\n</skill_content>`,
  source,
  resultIndex: 0,
});

describe("contextResetHistory", () => {
  test("system, ONE restart message, then one skill round per carried skill — no orphan call", () => {
    const next = contextResetHistory({
      systemPrompt: "FRESH SYSTEM",
      prompt: "goal: ship slice 3; plan in docs/plan.md",
      jobs: [{ id: "j1", command: "bun run dev" }],
      skills: { kept: [carried("alpha"), carried("gone", "unavailable")], dropped: [] },
    });
    expect(next.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(next[0]?.content).toBe("FRESH SYSTEM");
    const restart = next[1]?.content ?? "";
    expect(restartPromptOf(restart)).toBe("goal: ship slice 3; plan in docs/plan.md");
    expect(restart).toContain("Background jobs still running");
    expect(restart).toContain("- j1: `bun run dev`");
    expect(restart).toContain(
      'The skills active before the context reset are loaded again below; their instructions still apply: "alpha", "gone".',
    );
    expect(restart).toContain('No longer in the Skills list: "gone".');
    // Every assistant call is answered by the next message.
    expect(next[2]?.toolCalls?.[0]?.id).toBe("c-alpha");
    expect(next[3]?.toolCallId).toBe("c-alpha");
    expect(next[4]?.toolCalls?.[0]?.id).toBe("c-gone");
    expect(next[5]?.toolCallId).toBe("c-gone");
  });

  test("no jobs, no skills: exactly [system, restartMessage(prompt)]", () => {
    expect(
      contextResetHistory({
        systemPrompt: "S",
        prompt: "p",
        jobs: [],
        skills: { kept: [], dropped: [] },
      }),
    ).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: restartMessage("p") },
    ]);
  });
});

describe("resetRefusal", () => {
  const ok = {
    calls: 1,
    prompt: "next step",
    otherCallSinceReset: true,
    resetsThisMessage: 0,
    maxPerMessage: -1,
  };
  test("accepted: null", () => {
    expect(resetRefusal(ok)).toBeNull();
    expect(resetRefusal({ ...ok, resetsThisMessage: 40 })).toBeNull(); // -1 = unlimited
    expect(resetRefusal({ ...ok, maxPerMessage: 2, resetsThisMessage: 1 })).toBeNull();
  });
  test("each rule refuses with its reason", () => {
    expect(resetRefusal({ ...ok, calls: 2 })).toContain("only tool call");
    for (const prompt of [undefined, "", "   \n", 42]) {
      expect(resetRefusal({ ...ok, prompt })).toContain("empty");
    }
    expect(resetRefusal({ ...ok, otherCallSinceReset: false })).toContain("since your previous");
    expect(resetRefusal({ ...ok, maxPerMessage: 1, resetsThisMessage: 1 })).toContain("limit of 1");
  });
});

describe("skillSetDelta / offeredSkillNames", () => {
  test("added and removed names, or nothing", () => {
    expect(skillSetDelta(["a", "b"], ["b", "c"])).toBe("skills: + c, − a");
    expect(skillSetDelta([], ["x"])).toBe("skills: + x");
    expect(skillSetDelta(["x"], [])).toBe("skills: − x");
    expect(skillSetDelta(["a"], ["a"])).toBe("");
  });
  test("reads the `skill` tool's enum; none → []", () => {
    const defs = [
      { name: "shell", description: "", parameters: {} },
      {
        name: "skill",
        description: "",
        parameters: { type: "object", properties: { name: { enum: ["a", "b"] } } },
      },
    ];
    expect(offeredSkillNames(defs)).toEqual(["a", "b"]);
    expect(offeredSkillNames(defs.slice(0, 1))).toEqual([]);
  });
});
