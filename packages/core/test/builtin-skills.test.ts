import { describe, expect, test } from "bun:test";
import { BUILTIN_SKILL_NAMES, builtinDefaultOff, isBuiltinSkillName } from "../src/index.ts";

const builtin = (name: string) => ({ name, builtin: true as const });

describe("built-in skills", () => {
  test("the three names, sorted", () => {
    expect(BUILTIN_SKILL_NAMES).toEqual(["tentacle", "tentacle-a2a", "tentacle-workflows"]);
    expect(isBuiltinSkillName("tentacle-a2a")).toBe(true);
    expect(isBuiltinSkillName("a2a")).toBe(false);
  });

  const all = [builtin("tentacle-workflows"), builtin("tentacle"), builtin("tentacle-a2a")];

  test("all off with nothing enabled, sorted", () => {
    expect(builtinDefaultOff(all, {})).toEqual(["tentacle", "tentacle-a2a", "tentacle-workflows"]);
  });

  test("an enabled one is left on; `false` stays off", () => {
    expect(builtinDefaultOff(all, { tentacle: true, "tentacle-a2a": false })).toEqual([
      "tentacle-a2a",
      "tentacle-workflows",
    ]);
  });

  test("a user's skill that shadows a built-in is never seeded off", () => {
    const skills = [{ name: "tentacle" }, builtin("tentacle-a2a"), { name: "other" }];
    expect(builtinDefaultOff(skills, {})).toEqual(["tentacle-a2a"]);
  });
});
