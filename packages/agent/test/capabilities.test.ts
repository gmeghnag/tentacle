import { describe, expect, test } from "bun:test";
import { SKILLS_PROMPT_HEADER, type SkillInfo, composeSystemPrompt } from "@tentacle/config";
import type { ToolDefinition } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import {
  type CapabilityOp,
  NO_CAPABILITIES,
  type ServerOf,
  type SessionCapabilities,
  applyCapabilityOp,
  isHidden,
  isSkillHidden,
  projectSystem,
  projectTools,
} from "../src/capabilities.ts";

const caps = (over: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
  ...NO_CAPABILITIES,
  ...over,
});

const op = (kind: CapabilityOp["kind"], name: string, enabled: boolean): CapabilityOp => ({
  kind,
  name,
  enabled,
});

const skill = (name: string): SkillInfo => ({
  name,
  description: `does ${name}`,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  scope: "user",
  files: [],
  filesTruncated: false,
  modelInvocable: true,
  userInvocable: true,
});

/** A definition as `ToolRegistry.definitions()` builds it. */
const def = (name: string): ToolDefinition => ({
  name,
  description: `does ${name}`,
  parameters: {},
});

/** The lookup S2 passes: a tool's `mcpServer` tag, by tool name. */
const serversOf =
  (tags: Record<string, string>): ServerOf =>
  (name) =>
    tags[name];

/** The `skill` definition the registry builds from a Zod enum (the real shape). */
function skillDefinition(names: readonly string[]): ToolDefinition {
  const [first, ...rest] = names;
  if (first === undefined) {
    throw new Error("skillDefinition needs at least one name");
  }
  const registry = new ToolRegistry();
  registry.register({
    name: "skill",
    description: "load a skill",
    inputSchema: z.object({ name: z.enum([first, ...rest]) }),
    permission: "none",
    execute: async () => ({ content: "" }),
  });
  const [definition] = registry.definitions();
  if (definition === undefined) {
    throw new Error("skill definition missing");
  }
  return definition;
}

/** The `skill` definition's enum, as the model-facing JSON Schema carries it. */
const enumOf = (d: ToolDefinition): unknown =>
  (d.parameters.properties as { name?: { enum?: unknown } } | undefined)?.name?.enum;

describe("applyCapabilityOp", () => {
  test("disables and re-enables, keeping the set sorted and unique", () => {
    const a = applyCapabilityOp(caps(), op("mcp", "k8s", false));
    expect(a.disabledMcp).toEqual(["k8s"]);
    const b = applyCapabilityOp(a, op("mcp", "echo", false));
    expect(b.disabledMcp).toEqual(["echo", "k8s"]);
    const c = applyCapabilityOp(b, op("mcp", "k8s", true));
    expect(c.disabledMcp).toEqual(["echo"]);
    expect(c.disabledSkills).toEqual([]);
  });

  test("skills and servers are separate sets", () => {
    expect(applyCapabilityOp(caps(), op("skill", "k8s", false))).toEqual({
      disabledMcp: [],
      disabledSkills: ["k8s"],
    });
  });

  test("idempotent: the SAME object comes back when nothing changed", () => {
    const on = caps();
    expect(applyCapabilityOp(on, op("mcp", "k8s", true))).toBe(on);
    const off = applyCapabilityOp(on, op("mcp", "k8s", false));
    expect(applyCapabilityOp(off, op("mcp", "k8s", false))).toBe(off);
    expect(applyCapabilityOp(off, op("skill", "k8s", true))).toBe(off);
  });

  test("an unsorted, duplicated set collapses; the input is never mutated", () => {
    const messy = { disabledMcp: ["b", "a", "b"], disabledSkills: [] };
    expect(applyCapabilityOp(messy, op("mcp", "c", false)).disabledMcp).toEqual(["a", "b", "c"]);
    expect(messy.disabledMcp).toEqual(["b", "a", "b"]);
  });
});

describe("projectTools", () => {
  const tags = { mcp__echo__echo: "echo", mcp__a__b__echo: "a__b", mcp__a__b__x: "a__b" };

  test("drops exactly the disabled server's tools, by tag", () => {
    const defs = [def("fs_read"), ...Object.keys(tags).map(def)];
    const out = projectTools(defs, serversOf(tags), caps({ disabledMcp: ["a__b"] }));
    expect(out.map((d) => d.name)).toEqual(["fs_read", "mcp__echo__echo"]);
  });

  test("server a__b is not confused with a (mutation: parse the name → red)", () => {
    const defs = Object.keys(tags).map(def);
    const out = projectTools(defs, serversOf(tags), caps({ disabledMcp: ["a"] }));
    expect(out.map((d) => d.name)).toEqual([...Object.keys(tags)]);
  });

  test("nothing disabled → the same array back", () => {
    const defs = [def("fs_read"), def("mcp__echo__echo")];
    expect(projectTools(defs, serversOf(tags), caps())).toBe(defs);
  });

  test("filters the skill enum; the same array back when no skill is hidden", () => {
    const defs = [def("fs_read"), skillDefinition(["k8s", "damajs"])];
    expect(projectTools(defs, serversOf(tags), caps({ disabledMcp: ["echo"] }))).toBe(defs);

    const out = projectTools(defs, serversOf(tags), caps({ disabledSkills: ["k8s"] }));
    expect(out.map((d) => d.name)).toEqual(["fs_read", "skill"]);
    expect(enumOf(out[1] as ToolDefinition)).toEqual(["damajs"]);
    // The stored definition is never mutated.
    expect(enumOf(defs[1] as ToolDefinition)).toEqual(["k8s", "damajs"]);
  });

  test("drops the skill tool entirely when every skill is hidden", () => {
    const defs = [def("fs_read"), skillDefinition(["k8s", "damajs"])];
    const out = projectTools(defs, serversOf(tags), caps({ disabledSkills: ["k8s", "damajs"] }));
    expect(out.map((d) => d.name)).toEqual(["fs_read"]);
  });
});

describe("projectSystem", () => {
  const offered = [skill("k8s"), skill("damajs")];
  const full = composeSystemPrompt({
    identity: "ID",
    agentsMd: "RULES",
    agentsEnabled: true,
    skills: offered,
  }).systemPrompt;

  test("byte-equals a prompt composed without the hidden skills (the exact property)", () => {
    const out = projectSystem(full, offered, caps({ disabledSkills: ["k8s"] }));
    expect(out).toBe(
      composeSystemPrompt({
        identity: "ID",
        agentsMd: "RULES",
        agentsEnabled: true,
        skills: [skill("damajs")],
      }).systemPrompt,
    );
    expect(out).not.toContain("<name>k8s</name>");
  });

  test("everything hidden, no AGENTS.md → byte-equals the prompt with no catalog", () => {
    const bare = composeSystemPrompt({
      identity: "ID",
      agentsEnabled: true,
      skills: offered,
    }).systemPrompt;
    const out = projectSystem(bare, offered, caps({ disabledSkills: ["k8s", "damajs"] }));
    expect(out).toBe(
      composeSystemPrompt({ identity: "ID", agentsEnabled: true, skills: [] }).systemPrompt,
    );
    expect(out).not.toContain(SKILLS_PROMPT_HEADER);
  });

  test("everything hidden with an AGENTS.md → the prompt without a catalog, trimEnd'ed", () => {
    // `composeSystemPrompt` keeps a trailing newline for a folded AGENTS.md
    // block; the projection gives `withAgents.trimEnd()` (Design, F11) — the
    // one-byte difference between the two, made explicit here.
    const out = projectSystem(full, offered, caps({ disabledSkills: ["k8s", "damajs"] }));
    expect(out).toBe(
      composeSystemPrompt({
        identity: "ID",
        agentsMd: "RULES",
        agentsEnabled: true,
        skills: [],
      }).systemPrompt.trimEnd(),
    );
    expect(out).toBe("ID\n\n# Project rules (AGENTS.md)\n\nRULES");
    expect(out).not.toContain(SKILLS_PROMPT_HEADER);
  });

  test("nothing hidden → the same string back", () => {
    expect(projectSystem(full, offered, caps())).toBe(full);
  });

  test("no catalog in the prompt → unchanged, whatever is hidden", () => {
    const bare = composeSystemPrompt({
      identity: "ID",
      agentsEnabled: true,
      skills: [],
    }).systemPrompt;
    expect(projectSystem(bare, offered, caps({ disabledSkills: ["k8s"] }))).toBe(bare);
  });

  test("an AGENTS.md mentioning the header is still cut at the LAST one", () => {
    const agentsMd = "# Skills\n\nprose about skills, not a catalog";
    const systemPrompt = composeSystemPrompt({
      identity: "ID",
      agentsMd,
      agentsEnabled: true,
      skills: offered,
    }).systemPrompt;
    const out = projectSystem(systemPrompt, offered, caps({ disabledSkills: ["k8s"] }));
    expect(out).toStartWith("ID\n\n# Project rules (AGENTS.md)\n\n# Skills\n\nprose about skills");
    expect(out).not.toContain("<name>k8s</name>");
    expect(out).toContain("<name>damajs</name>");
    expect(out).toBe(
      composeSystemPrompt({
        identity: "ID",
        agentsMd,
        agentsEnabled: true,
        skills: [skill("damajs")],
      }).systemPrompt,
    );
  });
});

describe("isHidden / isSkillHidden (the execution guard's predicates)", () => {
  const tags = { mcp__echo__echo: "echo", mcp__a__b__echo: "a__b" };

  test("a disabled server's tool is hidden; a built-in never is", () => {
    const state = caps({ disabledMcp: ["echo"] });
    expect(isHidden("mcp__echo__echo", serversOf(tags), state)).toBe(true);
    expect(isHidden("mcp__a__b__echo", serversOf(tags), state)).toBe(false);
    expect(isHidden("fs_read", serversOf(tags), state)).toBe(false);
  });

  test("a disabled skill is hidden by name", () => {
    const state = caps({ disabledSkills: ["k8s"] });
    expect(isSkillHidden("k8s", state)).toBe(true);
    expect(isSkillHidden("damajs", state)).toBe(false);
  });
});
