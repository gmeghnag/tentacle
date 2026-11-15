/**
 * The Live Activity RENDER spec (docs/feat/mobile-live-activity.md Design 7,
 * slice L9): `ActivityContent → view-model`, as pure data.
 *
 * This module is the SPEC the widget's SwiftUI views follow, and the vectors
 * (`fixtures/la-render-v1.json`) are asserted by BOTH this test and the Swift
 * tests (L10), so the two implementations cannot drift (decision 20: logic in
 * pure modules, pinned by shared vectors).
 *
 * Rules that are security-relevant, not cosmetic:
 *  - **Approve is only ever offered for an `allow_once` option** (`reject_once`
 *    for Deny). An activity can never offer a lasting rule (decision 8, Owner Q6),
 *    and `allow_always` must produce NO button at all.
 *  - **Anything unrenderable is the PLACEHOLDER** — "tentacle — open to see", no
 *    buttons. An unknown `v`, an unknown `kind`, a missing ask: never a guess, so
 *    a hostile relay's junk shows nothing and offers nothing (F6, F22).
 *  - **`title` and the ask's `preview` are PRIVATE** (Owner Q7): hidden on a
 *    locked lock screen. The view-model says which fields are private; the Swift
 *    view applies `.privacySensitive()`, so the policy lives here, once.
 *  - Every string is bound-checked and ANSI-stripped: it came from a daemon that
 *    may be a pod (the second belt after `fitActivityContent`).
 */
import { describe, expect, test } from "bun:test";
import type { ActivityContent } from "@tentacle/protocol";
import { LA_PLACEHOLDER_TEXT, type LaViewModel, renderActivity } from "../src/la-render.ts";
import vectors from "./fixtures/la-render-v1.json";

const base: ActivityContent = {
  v: 1,
  slot: "00112233445566778899aabb",
  seq: 7,
  at: 1_731_000_000_000,
  kind: "running",
  computer: "mac-mini",
  project: "tentacle",
  title: "fix the live activity",
  turnId: "t1",
  startedAt: 1_730_999_980_000,
  tool: "bun test",
};

const asking = (
  options: ActivityContent["ask"] extends undefined
    ? never
    : NonNullable<ActivityContent["ask"]>["options"],
): ActivityContent => ({
  ...base,
  kind: "asking",
  ask: { requestId: "req-1", tool: "Shell", preview: "rm -rf build", options },
});

describe("the view-model: what the widget draws", () => {
  test("a running activity names the project, the phase, the tool and the start", () => {
    const view = renderActivity(base);
    expect(view.placeholder).toBe(false);
    expect(view.project).toBe("tentacle");
    expect(view.phase).toBe("running");
    // Elapsed is DRAWN on the phone, from this origin: it never costs an update.
    expect(view.startedAt).toBe(base.startedAt);
    expect(view.tool).toBe("bun test");
    // The title is display-only, and PRIVATE (Owner Q7).
    expect(view.title).toBe("fix the live activity");
    expect(view.privateFields).toContain("title");
    expect(view.buttons).toEqual([]);
  });

  test("a done / failed / cancelled activity says so, and offers nothing", () => {
    for (const kind of ["done", "failed", "cancelled"] as const) {
      const view = renderActivity({
        ...base,
        kind,
        ...(kind === "failed" ? { error: "boom" } : {}),
      });
      expect(view.phase).toBe(kind);
      expect(view.buttons).toEqual([]);
      expect(view.placeholder).toBe(false);
    }
  });

  test("`asking` offers Approve / Deny for the offered options, and nothing else", () => {
    const view = renderActivity(
      asking([
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "reject_once", kind: "reject_once" },
      ]),
    );
    expect(view.phase).toBe("asking");
    expect(view.buttons).toEqual([
      { action: "approve", optionId: "allow_once" },
      { action: "deny", optionId: "reject_once" },
    ]);
    // The preview is the reason to look, and it is PRIVATE while locked.
    expect(view.preview).toBe("rm -rf build");
    expect(view.privateFields).toContain("preview");
    expect(view.tool).toBe("Shell");
  });

  test("`allow_always` NEVER becomes a button (Owner Q6: no lasting rule from a lock screen)", () => {
    // Mutation: map `allow_always` to Approve → this fails, and a lock screen
    // could grant a rule the in-app sheet exists to make deliberate.
    const view = renderActivity(asking([{ optionId: "a-always", kind: "allow_always" }]));
    expect(view.buttons).toEqual([]);
    // It is still `asking` — the person sees that something waits and opens the app.
    expect(view.phase).toBe("asking");
  });

  test("only `reject_once` available: Deny alone", () => {
    const view = renderActivity(asking([{ optionId: "reject_once", kind: "reject_once" }]));
    expect(view.buttons).toEqual([{ action: "deny", optionId: "reject_once" }]);
  });

  test("an `asking` with no ask at all is a placeholder (never a guessed button)", () => {
    const view = renderActivity({ ...base, kind: "asking" });
    expect(view.placeholder).toBe(true);
    expect(view.buttons).toEqual([]);
    expect(view.text).toBe(LA_PLACEHOLDER_TEXT);
    // Nothing is marked private, because nothing of the content is shown.
    expect(view.title).toBeUndefined();
    expect(view.preview).toBeUndefined();
  });
});

describe("the placeholder: unknown versions and kinds (F6, F22)", () => {
  test("an unknown `v` renders the placeholder, with no buttons and no content", () => {
    const view = renderActivity({ ...base, v: 2 } as unknown as ActivityContent);
    expect(view.placeholder).toBe(true);
    expect(view.buttons).toEqual([]);
    expect(view.text).toBe(LA_PLACEHOLDER_TEXT);
    expect(view.slot).toBeUndefined();
  });

  test("an unknown `kind` renders the placeholder", () => {
    const view = renderActivity({ ...base, kind: "thinking" } as unknown as ActivityContent);
    expect(view.placeholder).toBe(true);
    expect(view.buttons).toEqual([]);
  });

  test("a missing or malformed field is a placeholder, never a throw", () => {
    // A widget that threw would show nothing at all (iOS drops the update) — the
    // placeholder at least says "open the app".
    for (const broken of [
      { ...base, project: undefined },
      { ...base, startedAt: Number.NaN },
      null,
      "not an object",
    ]) {
      expect(() => renderActivity(broken as unknown as ActivityContent)).not.toThrow();
      expect(renderActivity(broken as unknown as ActivityContent).placeholder).toBe(true);
    }
  });
});

describe("strings are sanitized: a pod-originated daemon is not trusted", () => {
  test("ANSI escapes are stripped and control characters dropped", () => {
    const view = renderActivity({
      ...base,
      project: "\u001b[31mtentacle\u001b[0m",
      title: "bell\u0007 here",
      tool: "a\u009bb",
    });
    expect(view.project).toBe("tentacle");
    expect(view.title).toBe("bell here");
    expect(view.tool).toBe("ab");
  });

  test("every string is bounded, so a hostile state cannot flood the view", () => {
    const view = renderActivity({ ...base, title: "x".repeat(5000), project: "y".repeat(5000) });
    expect((view.title ?? "").length).toBeLessThanOrEqual(120);
    expect((view.project ?? "").length).toBeLessThanOrEqual(120);
  });
});

describe("the shared vectors: one spec, two implementations (L10)", () => {
  test("every vector's expected view-model is what this module produces", () => {
    // The file is asserted by the Swift tests too, so a change here without one
    // there is a drift the gate catches.
    for (const entry of vectors.cases as {
      name: string;
      content: ActivityContent;
      expect: LaViewModel;
    }[]) {
      expect({ name: entry.name, view: renderActivity(entry.content) }).toEqual({
        name: entry.name,
        view: entry.expect,
      });
    }
    // Non-vacuity: the file really carries the cases this suite is about.
    const names = (vectors.cases as { name: string }[]).map((entry) => entry.name);
    expect(names).toContain("running");
    expect(names).toContain("asking-offer-both");
    expect(names).toContain("asking-allow-always");
    expect(names).toContain("unknown-kind");
  });
});
