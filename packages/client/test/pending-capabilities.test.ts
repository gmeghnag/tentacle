import { describe, expect, test } from "bun:test";
import {
  type CapabilityFlip,
  SwitchesNotAppliedError,
  flipRefusal,
  noteFlip,
  previewBase,
  previewCapabilities,
  vanishedSkills,
} from "../src/pending-capabilities.ts";

// The pure decision logic of the switches flipped BEFORE the first message
// (docs/feat/caps-before-first-message.md D1, T-C5's pure half). The preview
// reuses the agent's `applyCapabilityOp`, so these cases are also the daemon's.

const off = (kind: CapabilityFlip["kind"], name: string): CapabilityFlip => ({
  kind,
  name,
  enabled: false,
});
const on = (kind: CapabilityFlip["kind"], name: string): CapabilityFlip => ({
  kind,
  name,
  enabled: true,
});

const EMPTY = { disabledMcp: [], disabledSkills: [], disabledTools: [] };

describe("noteFlip: last wins per key, the key moves to the end", () => {
  test("a repeated key replaces the earlier flip and goes last", () => {
    // Mutation: keep the FIRST flip of a key (append without filtering) → red.
    const one = noteFlip([], off("skill", "deploy"));
    expect(one).toEqual([off("skill", "deploy")]);
    const twice = noteFlip(one, on("skill", "deploy"));
    expect(twice).toEqual([on("skill", "deploy")]);
    const mixed = noteFlip([off("tool", "chart"), off("skill", "deploy")], on("tool", "chart"));
    expect(mixed).toEqual([off("skill", "deploy"), on("tool", "chart")]);
  });

  test("a group, then a member, then the group again: the press sequence's final state", () => {
    const seq = [off("tool", "visuals"), on("tool", "chart"), off("tool", "visuals")];
    const pending = seq.reduce<CapabilityFlip[]>((acc, flip) => noteFlip(acc, flip), []);
    // `chart` is its own key (a group and its member are different keys), the two
    // `visuals` presses collapse to the last one, which still applies LAST — so
    // the group's off wins over that older member-on, as the presses did.
    expect(pending).toEqual([on("tool", "chart"), off("tool", "visuals")]);
    expect(previewCapabilities(EMPTY, pending).caps.disabledTools).toEqual([
      "chart",
      "diagram",
      "present",
    ]);
  });
});

describe("previewCapabilities: the state the open's sets will leave", () => {
  test("a group expands to its members; a member after its group gives a partial group", () => {
    const group = previewCapabilities(EMPTY, [off("tool", "visuals")]);
    expect(group.refused).toEqual([]);
    expect(group.caps.disabledTools).toEqual(["chart", "diagram", "present"]);
    const partial = previewCapabilities(EMPTY, [off("tool", "visuals"), on("tool", "chart")]);
    // `visuals` covers diagram/present (+ chart); turning chart back on leaves
    // the rest off — exactly what the two live presses would leave.
    expect(partial.caps.disabledTools).toEqual(["diagram", "present"]);
  });

  test("a flip the agent's table refuses is returned, never applied", () => {
    const out = previewCapabilities(EMPTY, [
      off("skill", "deploy"),
      off("tool", "no-such-tool"),
      off("tool", "skill"),
    ]);
    expect(out.caps.disabledSkills).toEqual(["deploy"]);
    expect(out.caps.disabledTools).toEqual([]);
    expect(out.refused.map((f) => f.name)).toEqual(["no-such-tool", "skill"]);
  });

  test("the base is kept: a seed's off stays off unless a flip turns it on", () => {
    const base = { ...EMPTY, disabledTools: ["chart"] };
    expect(previewCapabilities(base, []).caps).toEqual(base);
    expect(previewCapabilities(base, [on("tool", "chart")]).caps.disabledTools).toEqual([]);
    const seedOff = { ...EMPTY, disabledMcp: ["echo"], disabledSkills: ["plan"] };
    expect(previewCapabilities(seedOff, [on("mcp", "echo")]).caps).toEqual({
      disabledMcp: [],
      disabledSkills: ["plan"],
      disabledTools: [],
    });
  });
});

describe("previewBase: what the create will seed, ∪ the host's own tool set", () => {
  test("seed ∪ base-disabled tools ∪ the host's, sorted and de-duplicated", () => {
    // Mutation: drop the host's names → the pod's `tools.enabled` row shows "on"
    // for a tool the create turns off (tool-toggles' review note) → red.
    expect(previewBase(undefined, [])).toEqual(EMPTY);
    expect(previewBase({ ...EMPTY, disabledTools: ["chart"] }, ["chart", "diagram"])).toEqual({
      disabledMcp: [],
      disabledSkills: [],
      disabledTools: ["chart", "diagram"],
    });
    expect(previewBase({ ...EMPTY, disabledMcp: ["echo"] }, ["z", "a"])).toEqual({
      disabledMcp: ["echo"],
      disabledSkills: [],
      disabledTools: ["a", "z"],
    });
  });
});

describe("vanishedSkills: a flipped skill the opened session does not list", () => {
  test("only skill flips, only absent names", () => {
    const flips = [off("skill", "deploy"), off("skill", "plan"), off("mcp", "echo")];
    expect(vanishedSkills(flips, ["plan", "echo"]).map((f) => f.name)).toEqual(["deploy"]);
    expect(vanishedSkills(flips, []).map((f) => f.name)).toEqual(["deploy", "plan"]);
  });
});

describe("SwitchesNotAppliedError: local only, recognised by name", () => {
  test("its name, its failures, and a one-line message", () => {
    const error = new SwitchesNotAppliedError([
      { kind: "tool", name: "visuals", enabled: false, reason: "unknown built-in tool" },
    ]);
    expect(error.name).toBe("SwitchesNotAppliedError");
    expect(error.failed).toHaveLength(1);
    expect(error.message).toContain("visuals off");
    expect(error.message).toContain("unknown built-in tool");
  });

  test("flipRefusal gives the daemon's own text for a refused flip", () => {
    expect(flipRefusal(off("tool", "skill"))).toContain("always on");
    expect(flipRefusal(off("tool", "nope"))).toContain("unknown built-in tool or group");
  });
});
