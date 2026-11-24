/**
 * The workflow screens' wiring (docs/feat/workflows-ui.md D4, slice 3), pinned
 * where Bun can reach it. The screens and `App.tsx` are `.tsx` (unimportable from
 * Bun: React Native's sources are Flow), so the structure is pinned from the
 * source — the `hub-tools-wiring.test.ts` pattern. What the screens DRAW comes
 * from `workflow-run-controller.test.ts` / `workflow-runs-controller.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const APP = code(read("App.tsx"));
const RUN = code(read("src", "screens", "WorkflowRun.tsx"));
const RUNS = code(read("src", "screens", "WorkflowRuns.tsx"));
const SESSION = code(read("src", "screens", "SessionScreen.tsx"));

/** `src` from `from` to the first `to` after it. */
const between = (src: string, from: string, to: string): string => {
  const at = src.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf(to, at + from.length);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
};

describe("two plain PUSH screens (never the Sheet route, never a Modal)", () => {
  test("the stack has both routes, and neither screen draws a <Modal>", () => {
    expect(APP).toContain('name="WorkflowRuns"');
    expect(APP).toContain('name="WorkflowRun"');
    expect(RUN).not.toContain("<Modal");
    expect(RUNS).not.toContain("<Modal");
  });
});

describe("the approve card shows the ask VERBATIM (§7)", () => {
  test("the ask's detail is never cut to a line count", () => {
    const ask = between(RUN, "function AskBlock", "\nfunction ");
    expect(ask).toContain("{ask.detail}");
    expect(ask).not.toContain("numberOfLines");
    // Scrollable instead of truncated.
    expect(ask).toContain("<ScrollView");
  });

  test("Allow once and Deny — no `allow_always` (a workflow approval is ONE decision)", () => {
    expect(RUN).toContain('onAnswer("allow_once")');
    expect(RUN).toContain('onAnswer("reject_once")');
    expect(RUN).not.toContain("allow_always");
  });
});

describe("the run route reuses the ONE session path and the ONE sheet", () => {
  const route = between(APP, "function WorkflowRunRoute", "\nfunction ");

  test("it attaches through RUNTIMES, never with `reopen` (archive rule, §7)", () => {
    expect(route).toContain("RUNTIMES.controller(link.client)");
    expect(route).toContain("runtime.open(id)");
    expect(route).not.toContain("reopen");
  });

  test("asks are answered only through the Session screen's own sheet (single broker)", () => {
    expect(route).toContain("SESSION_SCREENS.get(");
    expect(route).toContain("screen.sheet().answerFor(");
    // No second requester on the broker, no resolve of its own.
    expect(route).not.toContain("permissions");
    expect(route).not.toContain("resolvePermission");
  });

  test("a session another screen follows is borrowed, never left from here", () => {
    expect(route).toContain("borrowed: runtime.follows(sessionId)");
  });
});

describe("the hub entry", () => {
  test("the Session screen offers Workflows only with its callback (P6) and feeds its figure", () => {
    expect(SESSION).toContain("workflows: onOpenWorkflows");
    expect(SESSION).toContain("workflows: workflowsHub");
  });
});
