import { describe, expect, test } from "bun:test";
import { mergeAgentTypes, parseAgentDefinition, parseFrontmatter } from "../src/agent-defs.ts";
import { type AgentType, BUILTIN_AGENT_TYPES } from "../src/subagent.ts";

describe("parseFrontmatter", () => {
  test("splits frontmatter keys (incl. arrays) from the body", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: reviewer\ntools: [fs_read, shell]\n---\nBe meticulous.",
    );
    expect(data.name).toBe("reviewer");
    expect(data.tools).toEqual(["fs_read", "shell"]);
    expect(body).toBe("Be meticulous.");
  });

  test("no frontmatter → whole text is the body", () => {
    const { data, body } = parseFrontmatter("just a prompt");
    expect(data).toEqual({});
    expect(body).toBe("just a prompt");
  });
});

describe("parseAgentDefinition", () => {
  test("builds a typed agent with tools + model override", () => {
    const type = parseAgentDefinition(
      "---\nname: reviewer\ndescription: Review a diff.\ntools: [fs_read]\nmodel: big-model\n---\nYou review code.",
      "fallback",
    );
    expect(type).toEqual({
      name: "reviewer",
      description: "Review a diff.",
      prompt: "You review code.",
      tools: ["fs_read"],
      model: "big-model",
    });
  });

  test("falls back to the filename for name and 'all' tools", () => {
    const type = parseAgentDefinition("Do the thing.", "my-agent");
    expect(type.name).toBe("my-agent");
    expect(type.tools).toBe("all");
    expect(type.model).toBeUndefined();
    expect(type.contextWindow).toBeUndefined();
    expect(type.prompt).toBe("Do the thing.");
  });

  // docs/feat/context-awareness.md (Review F1): the window of the type's own model.
  test("contextWindow: a positive whole number is kept; anything else is ignored, like a bad model", () => {
    const def = (value: string) =>
      parseAgentDefinition(
        `---\nname: small\nmodel: small-model\ncontextWindow: ${value}\n---\nGo.`,
        "f",
      );
    expect(def("32000")).toEqual({
      name: "small",
      description: "",
      prompt: "Go.",
      tools: "all",
      model: "small-model",
      contextWindow: 32000,
    });
    for (const bad of ["0", "-1", "1.5", "32k", "", "[1]"]) {
      expect({ bad, window: def(bad).contextWindow }).toEqual({ bad, window: undefined });
    }
  });
});

describe("mergeAgentTypes", () => {
  test("user types override built-ins by name and append new ones", () => {
    const user: AgentType[] = [
      { name: "explore", description: "custom explore", prompt: "p", tools: "all" },
      { name: "reviewer", description: "r", prompt: "p", tools: ["fs_read"] },
    ];
    const merged = mergeAgentTypes(BUILTIN_AGENT_TYPES, user);
    // explore overridden in place; general-purpose kept; reviewer appended.
    expect(merged.find((t) => t.name === "explore")?.description).toBe("custom explore");
    expect(merged.some((t) => t.name === "general-purpose")).toBe(true);
    expect(merged.at(-1)?.name).toBe("reviewer");
  });
});
