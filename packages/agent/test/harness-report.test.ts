/**
 * The report buffer (docs/fix/a2a-stream-duplicate.md): A2A `append:false` is a
 * REPLACE of that artifact's text, so the parent reads the answer once. Pure
 * module, no runner: the seam that used to lose `replace` is pinned separately
 * (`harness-remote-fit.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  appendReport,
  applyOutput,
  createReport,
  reportText,
  setReport,
} from "../src/harness/report.ts";
import type { HarnessEvent } from "../src/harness/types.ts";

type Output = Extract<HarnessEvent, { kind: "output" }>;

function buffer(events: Output[]) {
  const buf = createReport();
  for (const ev of events) applyOutput(buf, ev);
  return buf;
}

describe("report buffer", () => {
  test("replace rewrites only its artifact", () => {
    const buf = buffer([
      { kind: "output", text: "Ot", fromArtifact: "response" },
      { kind: "output", text: "tarina-42", fromArtifact: "response" },
      { kind: "output", replace: true, fromArtifact: "response" },
      { kind: "output", text: "OT-42", fromArtifact: "response" },
    ]);
    // Mutation: make `applyOutput` ignore `replace` → "Ottarina-42OT-42" → red.
    expect(reportText(buf)).toBe("OT-42");
  });

  test("no replace → byte-identical concatenation, in arrival order", () => {
    const buf = buffer([
      { kind: "output", text: "a" },
      { kind: "output", text: "b", fromArtifact: "x" },
      { kind: "output", data: { k: 1 }, fromArtifact: "x" },
      { kind: "output", file: { name: "a.bin", mediaType: "application/x", bytes: 9 } },
      { kind: "output", text: "c", fromArtifact: "x" },
    ]);
    expect(reportText(buf)).toBe(
      'ab\n{"k":1}\n[file] a.bin (application/x, 9 bytes) — listed, not savedc',
    );
  });

  test("an empty replacement clears the segment (and only it)", () => {
    const buf = buffer([
      { kind: "output", text: "kept", fromArtifact: "other" },
      { kind: "output", text: "stale", fromArtifact: "response" },
      { kind: "output", replace: true, fromArtifact: "response" },
    ]);
    // D4: our daemon closes an empty unit with `parts: []` — the deltas must go.
    expect(reportText(buf)).toBe("kept");
  });

  test("a replacement after an interleaved artifact keeps the other one, in order", () => {
    const buf = buffer([
      { kind: "output", text: "notes-", fromArtifact: "notes" },
      { kind: "output", text: "Ot", fromArtifact: "response" },
      { kind: "output", text: "tail", fromArtifact: "notes" },
      { kind: "output", text: "tarina-42", fromArtifact: "response" },
      { kind: "output", replace: true, fromArtifact: "response" },
      { kind: "output", text: "OTTARINA-42", fromArtifact: "response" },
    ]);
    // Ids are independent: only `response`'s text is rewritten, `notes` is whole.
    expect(reportText(buf)).toBe("notes-tailOTTARINA-42");
  });

  test("a replace with no fromArtifact clears the plain tail, never drops text silently", () => {
    const buf = buffer([
      { kind: "output", text: "kept", fromArtifact: "response" },
      { kind: "output", text: "loose" },
      { kind: "output", replace: true },
    ]);
    expect(reportText(buf)).toBe("kept");
  });

  test("appendReport is the plain tail; setReport resets everything", () => {
    const buf = buffer([{ kind: "output", text: "answer", fromArtifact: "response" }]);
    appendReport(buf, "\n\n(cancel not confirmed)");
    expect(reportText(buf)).toBe("answer\n\n(cancel not confirmed)");
    setReport(buf, "needs input to continue: which?");
    expect(reportText(buf)).toBe("needs input to continue: which?");
  });
});
