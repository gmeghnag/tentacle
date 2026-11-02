import { describe, expect, test } from "bun:test";
import { runModelPlan } from "../src/run-model.ts";

const none = { profile: false, model: false };

describe("runModelPlan (docs/fix/detach-live.md round 10, owner A)", () => {
  test("the run's profile and model, when this command named none", () => {
    expect(runModelPlan({ model: "deep-chat", profile: "deep" }, { model: "qwen" }, none)).toEqual({
      kind: "run",
      profile: "deep",
      model: "deep-chat",
    });
  });

  test("a run with no profile: the default config, with the run's model", () => {
    expect(runModelPlan({ model: "old" }, { model: "new", profile: "p" }, none)).toEqual({
      kind: "run",
      model: "old",
    });
  });

  test("already the run's: as is", () => {
    expect(runModelPlan({ model: "m", profile: "p" }, { model: "m", profile: "p" }, none)).toEqual({
      kind: "as-is",
    });
  });

  test("an explicit --profile / TENTACLE_PROFILE or TENTACLE_MODEL wins", () => {
    const run = { model: "deep-chat", profile: "deep" };
    expect(runModelPlan(run, { model: "q" }, { profile: true, model: false })).toEqual({
      kind: "as-is",
    });
    expect(runModelPlan(run, { model: "q" }, { profile: false, model: true })).toEqual({
      kind: "as-is",
    });
  });
});
