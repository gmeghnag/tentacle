import { describe, expect, test } from "bun:test";
import {
  NO_VERDICT_REASON,
  STEP_REMINDER_REPORT_MAX,
  planVerdictReminder,
} from "../src/workflow-verdict.ts";

// docs/fix/workflow-no-verdict (a): the reminder's DECISION and its TEXT are pure,
// so every gate is pinned here rather than through the driver.

const base = {
  stepId: "review",
  report: "the diff looks fine. PASS",
  usedTokens: 0,
  tokens: undefined,
  aborted: false,
};

describe("planVerdictReminder", () => {
  test("an aborted step gets no reminder: its outcome is already decided", () => {
    expect(planVerdictReminder({ ...base, aborted: true })).toBeUndefined();
  });

  test("a spent step budget gets no reminder; the remainder is the reminder's cap", () => {
    expect(planVerdictReminder({ ...base, tokens: 100, usedTokens: 100 })).toBeUndefined();
    // Over-spent on the first run: still no turn, and no negative cap.
    expect(planVerdictReminder({ ...base, tokens: 100, usedTokens: 140 })).toBeUndefined();
    expect(planVerdictReminder({ ...base, tokens: 100, usedTokens: 60 })?.maxTokens).toBe(40);
  });

  test("no step budget → no `maxTokens`, so the runner's default applies (as for run 1)", () => {
    const reminder = planVerdictReminder(base);
    expect(reminder).toBeDefined();
    expect(reminder !== undefined && "maxTokens" in reminder).toBe(false);
  });

  test("the prompt says to call the tool, and that a TEXT line is not a verdict", () => {
    const reminder = planVerdictReminder(base);
    expect(reminder?.prompt).toContain("step_verdict");
    expect(reminder?.prompt).toContain("NOT a verdict");
    // The step is named, so a report-less child still knows where it stands.
    expect(reminder?.prompt).toContain("review");
    // The first run's report travels with it: the two children share no history.
    expect(reminder?.prompt).toContain("the diff looks fine. PASS");
  });

  test("only the report's LAST chars are carried, capped", () => {
    const report = `HEAD-MARKER${"x".repeat(STEP_REMINDER_REPORT_MAX)}THE-END`;
    const prompt = planVerdictReminder({ ...base, report })?.prompt ?? "";
    // The END is kept (a conclusion lives there), the START is dropped.
    expect(prompt).toContain("THE-END");
    expect(prompt).not.toContain("HEAD-MARKER");
    expect(prompt.length).toBeLessThan(STEP_REMINDER_REPORT_MAX + 600);
  });

  test("an empty report adds no report block (no empty «Your work ended with»)", () => {
    const prompt = planVerdictReminder({ ...base, report: "" })?.prompt ?? "";
    expect(prompt).toContain("step_verdict");
    expect(prompt).not.toContain("Your work ended with this report:");
    // Whitespace is an empty report too.
    expect(planVerdictReminder({ ...base, report: "  \n " })?.prompt).not.toContain(
      "Your work ended with this report:",
    );
  });

  test("the sentence is ONE string, honest for a child that never got a reminder", () => {
    expect(NO_VERDICT_REASON).toBe("no verdict — the step ended without calling step_verdict");
  });
});
