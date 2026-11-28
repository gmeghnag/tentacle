/**
 * The native sheets' decisions (docs/feat/mobile-native-sheets.md D3): which
 * sheet, at which detent, and the ONE next step of the reconcile loop. Every
 * rule is pure, so it is pinned here rather than on a simulator (AGENTS §7).
 *
 * The dev asserts it must make impossible live in RNS
 * (`react-native-screens/src/components/helpers/sheet.tsx:11-19,58-66,92-99`):
 * unsorted detents, and an out-of-range initial or undimmed index, THROW in dev.
 */
import { describe, expect, test } from "bun:test";
import {
  DETENT_MEMORY_MAX,
  type DetentMemory,
  INTENT_SHEET,
  PEEK,
  PRESENTED_SHEET_KINDS,
  SHEET_DETENTS,
  SHEET_KINDS,
  SHEET_ROUTE,
  SHEET_SPEC,
  type SheetEntry,
  type SheetKind,
  askPresentable,
  askRouteId,
  askRouteParams,
  askingParamUpdate,
  clampDetent,
  createDetentMemory,
  desiredStack,
  dismissedNatively,
  drainPops,
  initialDetent,
  managedStack,
  openingDetent,
  ownRunOnTop,
  ownRunTopId,
  ownWorkflowsTop,
  queueAfterDismiss,
  readyIntents,
  reconcile,
  recordDetent,
  rememberDetent,
  rememberedDetent,
  sessionInFront,
  sheetDetentContext,
  sheetEntriesOf,
  sheetGestureEnabled,
  sheetGround,
  sheetHidden,
  sheetIdentity,
  sheetOptions,
  stackSignature,
  userSheet,
  yieldForeign,
} from "../src/sheet-plan.ts";
import { DENSE_FONT_SCALE } from "../src/theme.ts";

const CALM = { fontScale: 1 };
const DENSE = { fontScale: DENSE_FONT_SCALE };
const HIDDEN = { hidden: true, transitioning: false };
const SHOWN = { hidden: false, transitioning: false };
const MOVING = { hidden: false, transitioning: true };

/** Bottom→top entries, keys numbered in order (`a0`, `a1`, …). */
function stack(...kinds: SheetKind[]): SheetEntry[] {
  return kinds.map((kind, i) => ({ kind, key: `a${i}` }));
}

describe("SHEET_SPEC — the RNS dev asserts must be unreachable", () => {
  for (const kind of SHEET_KINDS) {
    test(`${kind}: detents ascend, initial and undimmed indexes are in range`, () => {
      const spec = SHEET_SPEC[kind];
      expect(spec.detents.length).toBe(3);
      for (let i = 1; i < spec.detents.length; i++) {
        expect(spec.detents[i] ?? 0).toBeGreaterThan(spec.detents[i - 1] ?? 0);
      }
      expect(Number.isInteger(spec.initial)).toBe(true);
      expect(spec.initial).toBeGreaterThanOrEqual(0);
      expect(spec.initial).toBeLessThanOrEqual(spec.detents.length - 1);
      // -1 is RNS's "dimmed at every detent"; any other value is an index.
      expect(spec.dimmed === -1 || (spec.dimmed >= 0 && spec.dimmed < spec.detents.length)).toBe(
        true,
      );
    });
  }

  test("every sheet opens at the middle detent; all but the ask are dimmed throughout", () => {
    for (const kind of SHEET_KINDS) {
      expect(initialDetent(kind, CALM)).toBe(1);
      expect(SHEET_SPEC[kind].dimmed).toBe(kind === "permission" ? 0 : -1);
      expect(SHEET_SPEC[kind].grabber).toBe(true);
    }
  });
});

describe("initialDetent", () => {
  test("the spec's index at a normal font scale", () => {
    expect(initialDetent("tools", CALM)).toBe(1);
    expect(initialDetent("permission", { fontScale: 1.0 })).toBe(1);
  });

  test("raised one step at a dense font scale", () => {
    expect(initialDetent("outbox", DENSE)).toBe(2);
    expect(initialDetent("permission", { fontScale: DENSE_FONT_SCALE })).toBe(2);
    expect(initialDetent("tools", { fontScale: DENSE_FONT_SCALE + 1 })).toBe(2);
  });

  test("a reveal opens at the largest detent, whatever the font scale", () => {
    expect(initialDetent("info", { ...CALM, reveal: true })).toBe(2);
    expect(initialDetent("info", { ...DENSE, reveal: true })).toBe(2);
    expect(initialDetent("info", CALM)).toBe(1);
  });

  test("a nonsense font scale is not dense", () => {
    expect(initialDetent("tools", { fontScale: Number.NaN })).toBe(1);
    expect(initialDetent("tools", { fontScale: 0 })).toBe(1);
  });
});

describe("sheetOptions — always accepted by RNS", () => {
  test("formSheet with the spec's detents, no header, expand on scroll", () => {
    const options = sheetOptions("tools", CALM);
    expect(options.presentation).toBe("formSheet");
    expect(options.headerShown).toBe(false);
    expect(options.sheetAllowedDetents).toEqual([0.3, 0.5, 1.0]);
    expect(options.sheetInitialDetentIndex).toBe(1);
    expect(options.sheetLargestUndimmedDetentIndex).toBe(-1);
    expect(options.sheetGrabberVisible).toBe(true);
    expect(options.sheetExpandsWhenScrolledToEdge).toBe(true);
  });

  test("detents come back sorted and the initial index clamped, whatever is passed", () => {
    const options = sheetOptions("permission", { ...CALM, detent: 9 });
    expect(options.sheetInitialDetentIndex).toBe(2);
    expect(sheetOptions("permission", { ...CALM, detent: -4 }).sheetInitialDetentIndex).toBe(0);
    const allowed = options.sheetAllowedDetents;
    const detents = Array.isArray(allowed) ? allowed : [];
    expect(detents.length).toBe(3);
    for (let i = 1; i < detents.length; i++) {
      expect(detents[i] ?? 0).toBeGreaterThanOrEqual(detents[i - 1] ?? 0);
    }
  });

  test("a remembered detent wins over the spec's", () => {
    expect(sheetOptions("outbox", { ...CALM, detent: 2 }).sheetInitialDetentIndex).toBe(2);
    expect(sheetOptions("outbox", DENSE).sheetInitialDetentIndex).toBe(2);
    expect(sheetOptions("outbox", CALM).sheetInitialDetentIndex).toBe(1);
  });

  test("clampDetent keeps an index inside the spec", () => {
    expect(clampDetent(SHEET_SPEC.tools, 1)).toBe(1);
    expect(clampDetent(SHEET_SPEC.tools, 7)).toBe(2);
    expect(clampDetent(SHEET_SPEC.tools, 1.5)).toBe(1);
    expect(clampDetent(SHEET_SPEC.tools, Number.NaN)).toBe(1);
  });
});

describe("sheetGestureEnabled — an ask never blocks (a swipe parks it)", () => {
  test("every sheet is always dismissible, asking or not", () => {
    for (const kind of SHEET_KINDS) {
      expect(sheetGestureEnabled(kind, true)).toBe(true);
      expect(sheetGestureEnabled(kind, false)).toBe(true);
    }
  });

  test("reaching sheetOptions", () => {
    expect(sheetOptions("permission", { ...CALM, asking: true }).gestureEnabled).toBe(true);
    expect(sheetOptions("permission", CALM).gestureEnabled).toBe(true);
    expect(sheetOptions("tools", { ...CALM, asking: true }).gestureEnabled).toBe(true);
  });

  test("behind the peek row the screen is live (dimmed 0), and the peek holds the slim row", () => {
    expect(sheetOptions("permission", CALM).sheetLargestUndimmedDetentIndex).toBe(0);
    expect(SHEET_SPEC.permission.dimmed).toBe(0);
    expect(SHEET_SPEC.permission.detents[0]).toBe(PEEK);
    expect(PEEK * 667).toBeGreaterThanOrEqual(76);
  });
});

describe("desiredStack — one user sheet, outbox above it, the ask on top", () => {
  const none = { user: null, outbox: false, permission: false } as const;

  test("empty", () => {
    expect(desiredStack(none)).toEqual([]);
  });

  test("one user sheet, whatever it is", () => {
    expect(desiredStack({ ...none, user: "tools" })).toEqual(["tools"]);
    expect(desiredStack({ ...none, user: "info" })).toEqual(["info"]);
    expect(desiredStack({ ...none, user: "commands" })).toEqual(["commands"]);
  });

  test("outbox sits above the user sheet", () => {
    expect(desiredStack({ ...none, user: "tools", outbox: true })).toEqual(["tools", "outbox"]);
    expect(desiredStack({ ...none, outbox: true })).toEqual(["outbox"]);
  });

  test("the ask is always on top, and only ever once", () => {
    expect(desiredStack({ user: "commands", outbox: true, permission: true })).toEqual([
      "commands",
      "outbox",
      "permission",
    ]);
    expect(desiredStack({ ...none, permission: true })).toEqual(["permission"]);
    const all = desiredStack({ user: "info", outbox: true, permission: true });
    expect(all.filter((k) => k === "permission").length).toBe(1);
    expect(all[all.length - 1]).toBe("permission");
  });
});

describe("userSheet — each of the three flags opens ITS sheet, one at a time", () => {
  const off = { commands: false, tools: false, info: false } as const;

  test("no flag, no user sheet", () => {
    expect(userSheet(off)).toBeNull();
  });

  test("each flag alone names its own sheet (Tools and Info reach the stack)", () => {
    expect(userSheet({ ...off, commands: true })).toBe("commands");
    expect(userSheet({ ...off, tools: true })).toBe("tools");
    expect(userSheet({ ...off, info: true })).toBe("info");
    const user = userSheet({ ...off, tools: true });
    expect(desiredStack({ user, outbox: false, permission: false })).toEqual(["tools"]);
  });

  test("two flags at once: the fixed precedence info > tools > commands", () => {
    expect(userSheet({ commands: true, tools: true, info: false })).toBe("tools");
    expect(userSheet({ commands: true, tools: false, info: true })).toBe("info");
    expect(userSheet({ commands: true, tools: true, info: true })).toBe("info");
  });
});

describe("reconcile — ONE step, top-only pops", () => {
  test("converged means no step", () => {
    expect(reconcile(["tools"], stack("tools"), SHOWN)).toBeNull();
    expect(reconcile([], [], SHOWN)).toBeNull();
    expect(reconcile(["tools", "permission"], stack("tools", "permission"), SHOWN)).toBeNull();
  });

  test("pushes the first missing kind, bottom→top", () => {
    expect(reconcile(["tools"], [], SHOWN)).toEqual({ action: "push", kind: "tools" });
    expect(reconcile(["tools", "permission"], stack("tools"), SHOWN)).toEqual({
      action: "push",
      kind: "permission",
    });
  });

  test("pops the TOP when there is one too many", () => {
    expect(reconcile(["tools"], stack("tools", "permission"), SHOWN)).toEqual({
      action: "pop",
      key: "a1",
    });
  });

  test("never pops a lower key — the top goes first", () => {
    // commands under tools where tools is wanted: pop the TOP (tools), then commands.
    const first = reconcile(["tools"], stack("commands", "tools"), SHOWN);
    expect(first).toEqual({ action: "pop", key: "a1" });
    const second = reconcile(["tools"], stack("commands"), SHOWN);
    expect(second).toEqual({ action: "pop", key: "a0" });
    expect(reconcile(["tools"], [], SHOWN)).toEqual({ action: "push", kind: "tools" });
  });

  test("a swap converges with pops only, never a push first", () => {
    let actual = stack("info", "permission");
    const steps: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = reconcile(["tools"], actual, SHOWN);
      if (step === null) break;
      steps.push(`${step.action}:${step.action === "pop" ? step.key : step.kind}`);
      actual =
        step.action === "pop"
          ? actual.filter((e) => e.key !== step.key)
          : [...actual, { kind: step.kind, key: `n${i}` }];
    }
    expect(steps).toEqual(["pop:a1", "pop:a0", "push:tools"]);
  });

  test("nothing runs while a transition is in flight (except the drain)", () => {
    expect(reconcile(["tools"], [], MOVING)).toBeNull();
    expect(reconcile([], stack("tools"), MOVING)).toBeNull();
  });

  test("hidden drains top-down and never pushes", () => {
    let actual = stack("tools", "permission");
    const popped: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = reconcile(["tools", "permission"], actual, HIDDEN);
      if (step === null) break;
      expect(step.action).toBe("pop");
      if (step.action !== "pop") break;
      popped.push(step.key);
      actual = actual.filter((e) => e.key !== step.key);
    }
    expect(popped).toEqual(["a1", "a0"]);
    expect(reconcile([], stack("tools"), HIDDEN)).toEqual({ action: "pop", key: "a0" });
    expect(reconcile(["tools", "permission"], [], HIDDEN)).toBeNull();
  });

  test("the drain does not wait for a transition", () => {
    expect(reconcile([], stack("tools"), { hidden: true, transitioning: true })).toEqual({
      action: "pop",
      key: "a0",
    });
  });

  test("after the drain the same sheets return in order, at once", () => {
    let actual: SheetEntry[] = [];
    const desired = desiredStack({ user: "tools", outbox: false, permission: true });
    const pushed: SheetKind[] = [];
    for (let i = 0; i < 10; i++) {
      const step = reconcile(desired, actual, SHOWN);
      if (step === null) break;
      expect(step.action).toBe("push");
      if (step.action !== "push") break;
      pushed.push(step.kind);
      actual = [...actual, { kind: step.kind, key: `r${i}` }];
    }
    expect(pushed).toEqual(["tools", "permission"]);
  });

  test("converges in at most (desired + actual) steps from any stack", () => {
    const all: readonly SheetKind[] = ["commands", "tools", "info", "outbox", "permission"];
    const desires: SheetKind[][] = [[], ...all.map((k) => [k]), ["commands", "permission"]];
    const stacks: SheetEntry[][] = [[], ...all.map((k) => stack(k)), stack("commands", "tools")];
    for (const desired of desires) {
      for (const start of stacks) {
        let actual = start;
        let steps = 0;
        while (steps < 20) {
          const step = reconcile(desired, actual, SHOWN);
          if (step === null) break;
          steps++;
          if (step.action === "pop") {
            // top-only, always
            const top = actual[actual.length - 1];
            expect(top?.key).toBe(step.key);
            actual = actual.slice(0, -1);
          } else {
            actual = [...actual, { kind: step.kind, key: `p${steps}` }];
          }
        }
        expect(actual.map((e) => e.kind)).toEqual(desired);
        expect(steps).toBeLessThanOrEqual(desired.length + start.length);
      }
    }
  });
});

describe("dismissedNatively — a planned pop is not a swipe", () => {
  test("a swiped key is reported", () => {
    expect(dismissedNatively(stack("tools"), [], [])).toEqual(["tools"]);
    expect(dismissedNatively(stack("tools", "permission"), stack("tools"), [])).toEqual([
      "permission",
    ]);
  });

  test("its own pop is ignored", () => {
    expect(dismissedNatively(stack("tools"), [], ["a0"])).toEqual([]);
    expect(dismissedNatively(stack("tools", "permission"), stack("tools"), ["a1"])).toEqual([]);
  });

  test("the routes a planned pop of a LOWER sheet also removed are ignored", () => {
    // F4: popping the lower route removes both. The upper one must not run a close handler.
    expect(dismissedNatively(stack("tools", "permission"), [], ["a0"])).toEqual([]);
  });

  test("a swipe above a planned pop is still reported", () => {
    const prev = stack("tools", "permission", "outbox");
    // planned pop of the bottom, the top two vanish with it — all collateral.
    expect(dismissedNatively(prev, [], ["a0"])).toEqual([]);
    // a real swipe of the top, nothing planned
    expect(dismissedNatively(prev, stack("tools", "permission"), [])).toEqual(["outbox"]);
  });

  test("a push is not a dismissal", () => {
    expect(dismissedNatively(stack("tools"), stack("tools", "permission"), [])).toEqual([]);
  });

  test("a kind is reported once", () => {
    expect(dismissedNatively(stack("outbox", "outbox"), [], [])).toEqual(["outbox"]);
  });
});

describe("detent memory — per identity, bounded", () => {
  test("a remembered detent is returned for the same identity only", () => {
    const memory = createDetentMemory();
    expect(openingDetent(memory, "permission", "ask-1", CALM)).toBe(1);
    rememberDetent(memory, "permission", "ask-1", 2);
    expect(rememberedDetent(memory, "permission", "ask-1")).toBe(2);
    expect(openingDetent(memory, "permission", "ask-1", CALM)).toBe(2);
    // A DIFFERENT ask (Step 0b L3: the re-delivery on resume is the same id) is fresh.
    expect(rememberedDetent(memory, "permission", "ask-2")).toBeNull();
    expect(openingDetent(memory, "permission", "ask-2", CALM)).toBe(1);
    // And a user sheet's identity is its kind, not the ask's.
    rememberDetent(memory, "tools", null, 0);
    expect(openingDetent(memory, "tools", null, CALM)).toBe(0);
    expect(openingDetent(memory, "info", null, CALM)).toBe(1);
  });

  test("a remembered index is clamped to the spec", () => {
    const memory = createDetentMemory();
    rememberDetent(memory, "outbox", null, 8);
    expect(rememberedDetent(memory, "outbox", null)).toBe(2);
    rememberDetent(memory, "outbox", null, -3);
    expect(rememberedDetent(memory, "outbox", null)).toBe(0);
  });

  test("re-remembering moves the identity to the newest, and the store is bounded", () => {
    const memory: DetentMemory = createDetentMemory();
    rememberDetent(memory, "permission", "ask-0", 2);
    for (let i = 1; i <= DETENT_MEMORY_MAX; i++) {
      rememberDetent(memory, "permission", `ask-${i}`, 1);
    }
    // ask-0 is the oldest and has been dropped; the newest survives.
    expect(rememberedDetent(memory, "permission", "ask-0")).toBeNull();
    expect(rememberedDetent(memory, "permission", `ask-${DETENT_MEMORY_MAX}`)).toBe(1);
    // Touching an old one keeps it alive.
    rememberDetent(memory, "permission", "ask-1", 2);
    for (let i = DETENT_MEMORY_MAX + 1; i <= DETENT_MEMORY_MAX * 2; i++) {
      rememberDetent(memory, "permission", `ask-${i}`, 1);
    }
    expect(rememberedDetent(memory, "permission", `ask-${DETENT_MEMORY_MAX * 2}`)).toBe(1);
    expect(memory.seen.size).toBeLessThanOrEqual(DETENT_MEMORY_MAX);
  });

  test("with no memory the spec's detent opens", () => {
    expect(openingDetent(null, "tools", null, CALM)).toBe(1);
    expect(openingDetent(createDetentMemory(), "info", null, { ...CALM, reveal: true })).toBe(2);
  });

  /**
   * The route's option object cannot see whether Session info was opened with a
   * reveal (`session-info.ts`'s tracker lives in the screen), so the screen
   * states it on that route's PARAMS and the navigator passes it in here (S4).
   * A remembered detent still wins: a sheet the person left at L re-opens at L.
   */
  test("`sheetDetentContext` carries the font scale, the remembered detent and the reveal", () => {
    // No memory, no reveal: the spec's index, and nothing else invented.
    expect(sheetDetentContext("info", null, 1)).toEqual({ fontScale: 1 });
    expect(initialDetent("info", sheetDetentContext("info", null, 1))).toBe(1);
    // Dynamic Type still reaches the larger detent through the same context.
    expect(initialDetent("tools", sheetDetentContext("tools", null, DENSE_FONT_SCALE))).toBe(2);
    // Info opened with a reveal (the hub's Scheduled item, `openScheduled`) opens
    // at L; the reveal belongs to Session info alone.
    expect(sheetDetentContext("info", null, 1, true)).toEqual({ fontScale: 1, reveal: true });
    expect(initialDetent("info", sheetDetentContext("info", null, 1, true))).toBe(2);
    expect(sheetDetentContext("tools", null, 1, true)).toEqual({ fontScale: 1 });
    // A remembered detent still wins: a sheet the person left at L re-opens at L.
    rememberDetent(SHEET_DETENTS, "tools", null, 2);
    expect(sheetDetentContext("tools", null, 1)).toEqual({ fontScale: 1, detent: 2 });
  });
});

describe("afterDismiss — intents that need the sheet gone first", () => {
  test("each intent belongs to one sheet", () => {
    expect(INTENT_SHEET.rename).toBe("commands");
    expect(INTENT_SHEET.artifacts).toBe("info");
  });

  test("queueing is idempotent and ordered", () => {
    let queue = queueAfterDismiss([], "rename");
    expect(queue).toEqual(["rename"]);
    queue = queueAfterDismiss(queue, "rename");
    expect(queue).toEqual(["rename"]);
    expect(queueAfterDismiss(queue, "artifacts")).toEqual(["rename", "artifacts"]);
  });

  test("nothing runs while a sheet is up or a transition is in flight", () => {
    expect(readyIntents(["rename"], stack("commands"), { transitioning: false })).toEqual({
      run: [],
      rest: ["rename"],
    });
    expect(readyIntents(["rename"], [], { transitioning: true })).toEqual({
      run: [],
      rest: ["rename"],
    });
  });

  test("runs once the stack is empty, or a close has finished", () => {
    expect(readyIntents(["rename"], [], { transitioning: false })).toEqual({
      run: ["rename"],
      rest: [],
    });
    // The closed route can still be in the navigation state at transitionEnd.
    expect(
      readyIntents(["rename"], stack("commands"), { transitioning: false, closingDone: true }),
    ).toEqual({ run: ["rename"], rest: [] });
    expect(readyIntents([], [], { transitioning: false })).toEqual({ run: [], rest: [] });
  });
});

describe("yieldForeign — no RN Modal while a sheet is up or coming", () => {
  test("true with a sheet up or about to be pushed", () => {
    expect(yieldForeign([], stack("tools"))).toBe(true);
    expect(yieldForeign(["tools"], [])).toBe(true);
    expect(yieldForeign(["tools"], stack("tools"))).toBe(true);
  });

  test("false with nothing up and nothing wanted", () => {
    expect(yieldForeign([], [])).toBe(false);
  });
});

describe("sessionInFront — this session is what the person sees", () => {
  test("focused, or one of our sheets is up", () => {
    expect(sessionInFront(true, [])).toBe(true);
    expect(sessionInFront(false, stack("permission"))).toBe(true);
    expect(sessionInFront(true, stack("tools"))).toBe(true);
  });

  test("blurred with no sheet up is behind", () => {
    expect(sessionInFront(false, [])).toBe(false);
  });

  test("S8: an own run on top keeps the session in front", () => {
    expect(sessionInFront(false, [], true)).toBe(true);
  });
});

describe("S8 — the run screen over a session (docs/fix/mobile-ask-surfaces.md D6)", () => {
  const owner = { computerId: "c", sessionId: "s" };
  const session = { key: "k0", name: "Session", params: { computerId: "c", sessionId: "s" } };
  const run = (sessionId: string, runId = "wf-1") => ({
    key: "k1",
    name: "WorkflowRun",
    params: { computerId: "c", sessionId, runId, title: "t" },
  });
  const sheetRoute = {
    key: "k2",
    name: "Sheet",
    params: { kind: "permission", computerId: "c", sessionId: "s" },
  };

  test("ownRunOnTop: this session's run on top is true, another session's is false", () => {
    expect(ownRunOnTop([session, run("s")], owner)).toBe(true);
    expect(ownRunOnTop([session, run("t")], owner)).toBe(false);
    expect(ownRunOnTop([session], owner)).toBe(false);
    expect(ownRunOnTop([], owner)).toBe(false);
  });

  test("a sheet over the run keeps it on top; another screen above it does not", () => {
    expect(ownRunOnTop([session, run("s"), sheetRoute], owner)).toBe(true);
    expect(ownRunOnTop([session, run("s"), { key: "k3", name: "Other" }], owner)).toBe(false);
    expect(ownRunTopId([session, run("s", "wf-7"), sheetRoute], owner)).toBe("wf-7");
    expect(ownRunTopId([session, run("t")], owner)).toBeNull();
  });

  test("askPresentable (Q1): over a run only THAT run's ask is presented", () => {
    const wf = (runId: string | null) => ({
      kind: "workflow" as const,
      name: "n",
      runId,
      stepId: "a",
      position: null,
    });
    expect(askPresentable({ kind: "main" }, null)).toBe(true);
    expect(askPresentable(wf("wf-2"), null)).toBe(true);
    expect(askPresentable(wf("wf-1"), "wf-1")).toBe(true);
    expect(askPresentable(wf("wf-2"), "wf-1")).toBe(false);
    expect(askPresentable(wf(null), "wf-1")).toBe(false);
    expect(askPresentable({ kind: "main" }, "wf-1")).toBe(false);
    expect(askPresentable({ kind: "subagent", type: "x", task: "y" }, "wf-1")).toBe(false);
  });
});

describe("the Workflows landing over a session (docs/fix/mobile-workflows-landing-v2.md D1)", () => {
  const owner = { computerId: "c", sessionId: "s" };
  const session = { key: "k0", name: "Session", params: { computerId: "c", sessionId: "s" } };
  const landing = (sessionId: string, computerId = "c") => ({
    key: "k1",
    name: "WorkflowStart",
    params: { computerId, sessionId },
  });
  const sheetRoute = {
    key: "k2",
    name: "Sheet",
    params: { kind: "permission", computerId: "c", sessionId: "s" },
  };
  const wf = (runId: string | null) => ({
    kind: "workflow" as const,
    name: "n",
    runId,
    stepId: null,
    position: null,
  });

  test("this session's landing on top (sheet or not) keeps it in front", () => {
    expect(ownWorkflowsTop([session, landing("s")], owner)).toBe(true);
    expect(ownWorkflowsTop([session, landing("s"), sheetRoute], owner)).toBe(true);
    expect(sessionInFront(false, [], ownWorkflowsTop([session, landing("s")], owner))).toBe(true);
  });

  test("another session's landing, or a screen above it, is not in front", () => {
    expect(ownWorkflowsTop([session, landing("t")], owner)).toBe(false);
    expect(ownWorkflowsTop([session, landing("s", "other")], owner)).toBe(false);
    expect(
      ownWorkflowsTop([session, landing("s"), { key: "k3", name: "WorkflowEdit" }], owner),
    ).toBe(false);
    expect(ownWorkflowsTop([session], owner)).toBe(false);
    expect(ownWorkflowsTop([], owner)).toBe(false);
  });

  const everyOrigin = [
    wf(null),
    wf("wf-1"),
    { kind: "main" as const },
    { kind: "subagent" as const, type: "x", task: "y" },
  ];

  test("over the landing an ask arrives as a banner: nothing is a sheet unreviewed", () => {
    // Mutation: ignore `reviewed` over the landing (return true) → red.
    for (const origin of everyOrigin) {
      expect(askPresentable(origin, null, true)).toBe(false);
      expect(askPresentable(origin, null, true, false)).toBe(false);
    }
  });

  test("over the landing a REVIEWED ask is a sheet, whoever asks", () => {
    for (const origin of everyOrigin) {
      expect(askPresentable(origin, null, true, true)).toBe(true);
    }
  });

  test("off the landing `reviewed` changes nothing, over a run or elsewhere", () => {
    for (const reviewed of [false, true]) {
      expect(askPresentable({ kind: "main" }, null, false, reviewed)).toBe(true);
      expect(askPresentable(wf(null), null, false, reviewed)).toBe(true);
      expect(askPresentable(wf("wf-1"), "wf-1", false, reviewed)).toBe(true);
      expect(askPresentable(wf("wf-2"), "wf-1", false, reviewed)).toBe(false);
      expect(askPresentable({ kind: "main" }, "wf-1", false, reviewed)).toBe(false);
    }
  });
});

describe("the 44 sequence — what Session's top-screen selectors see (docs/fix/mobile-fluidity-e2e.md)", () => {
  const owner = { computerId: "c", sessionId: "s" };
  const session = { key: "k0", name: "Session", params: owner };
  const landing = { key: "k1", name: "WorkflowStart", params: owner };
  const run = { key: "k2", name: "WorkflowRun", params: { ...owner, runId: "wf-1" } };
  const ask = { key: "k3", name: SHEET_ROUTE, params: { kind: "permission", ...owner } };
  // [Session, landing] → the run PUSHED over it → the ask's Sheet over the run.
  const before = [session, landing];
  const pushed = [session, landing, run];
  const sheeted = [session, landing, run, ask];
  const selected = (routes: Parameters<typeof ownRunTopId>[0]) =>
    [ownRunTopId(routes, owner), ownWorkflowsTop(routes, owner)] as const;

  test("both selections change by Object.is at the push, and neither at the Sheet", () => {
    expect(selected(before)).toEqual([null, true]);
    expect(selected(pushed)).toEqual(["wf-1", false]);
    for (const i of [0, 1] as const) {
      expect(Object.is(selected(before)[i], selected(pushed)[i])).toBe(false);
      expect(Object.is(selected(pushed)[i], selected(sheeted)[i])).toBe(true);
    }
    // Popped back to the landing: it flips back (the ask is a banner again).
    expect(selected(before)).toEqual([null, true]);
  });

  test("the sheet stack's signature cannot see the push: `stackKey` never could", () => {
    expect(stackSignature(pushed)).toBe(stackSignature(before));
  });
});

describe("sheetHidden — the drain's trigger, both legs", () => {
  test("locked is hidden, whatever the app state", () => {
    expect(sheetHidden(true, "active")).toBe(true);
    expect(sheetHidden(true, "inactive")).toBe(true);
    expect(sheetHidden(true, "background")).toBe(true);
  });

  test("any non-active app state is hidden (inactive is the load-bearing leg)", () => {
    expect(sheetHidden(false, "inactive")).toBe(true);
    expect(sheetHidden(false, "background")).toBe(true);
    expect(sheetHidden(false, "unknown")).toBe(true);
  });

  test("unlocked and active is not", () => {
    expect(sheetHidden(false, "active")).toBe(false);
  });
});

describe("sheetGround — the route's colour token", () => {
  test("the ask is the sheet surface, the rest the banded ground", () => {
    expect(sheetGround("permission")).toBe("sheet");
    for (const kind of SHEET_KINDS) {
      if (kind === "permission") continue;
      expect(sheetGround(kind)).toBe("bg");
    }
  });
});

describe("managedStack + stackSignature — what the build presents (S3/S4/S5)", () => {
  test("only the migrated kinds are pushed; order is desiredStack's", () => {
    expect(managedStack(["tools", "outbox", "permission"], PRESENTED_SHEET_KINDS)).toEqual([
      "tools",
      "outbox",
      "permission",
    ]);
    expect(managedStack(["info", "permission"], PRESENTED_SHEET_KINDS)).toEqual([
      "info",
      "permission",
    ]);
    expect(managedStack(["commands", "outbox"], PRESENTED_SHEET_KINDS)).toEqual([
      "commands",
      "outbox",
    ]);
    expect(managedStack([], PRESENTED_SHEET_KINDS)).toEqual([]);
  });

  test("S5's list is all five: the ask is a route too now", () => {
    // Mutation: drop "permission" from the list → red. Every kind is native as
    // of S5, so a kind missing here would be a Modal over an empty route.
    expect([...PRESENTED_SHEET_KINDS].sort()).toEqual(SHEET_KINDS.toSorted());
  });

  test("the signature is a string, and it changes only when the stack does", () => {
    const route = (key: string, kind: SheetKind) => ({
      key,
      name: SHEET_ROUTE,
      params: { kind },
    });
    const one = stackSignature([route("a", "commands")]);
    expect(one).toBe("a:commands");
    // The same stack, a fresh array: the same string (`useNavigationState` uses
    // Object.is, so an array here would re-render for ever).
    expect(stackSignature([route("a", "commands")])).toBe(one);
    expect(stackSignature([route("a", "commands"), route("b", "outbox")])).not.toBe(one);
    // A non-sheet route changes nothing.
    expect(stackSignature([{ key: "s", name: "Session" }, route("a", "commands")])).toBe(one);
    expect(stackSignature([])).toBe("");
  });
});

describe("sheetEntriesOf — the sheet stack read back from the navigator (S3)", () => {
  const route = (key: string, name: string, kind?: SheetKind) => ({
    key,
    name,
    ...(kind === undefined ? {} : { params: { computerId: "c", sessionId: "s", kind } }),
  });

  test("keeps only the `Sheet` routes, bottom→top, with their kinds", () => {
    const entries = sheetEntriesOf([
      route("s", "Session"),
      route("a", SHEET_ROUTE, "commands"),
      route("b", SHEET_ROUTE, "permission"),
    ]);
    expect(entries).toEqual([
      { kind: "commands", key: "a" },
      { kind: "permission", key: "b" },
    ]);
  });

  test("no sheet route at all is an empty stack, never a throw", () => {
    expect(sheetEntriesOf([route("s", "Session")])).toEqual([]);
    expect(sheetEntriesOf([])).toEqual([]);
  });

  test("another route carrying a `kind` param is not a sheet", () => {
    // The name is checked, not just the params: a future screen that names a
    // `kind` (a hub panel, say) must never enter the sheet stack.
    const entries = sheetEntriesOf([
      route("h", "Hub", "tools"),
      route("a", SHEET_ROUTE, "commands"),
    ]);
    expect(entries).toEqual([{ kind: "commands", key: "a" }]);
  });

  test("a route whose params name no known kind is ignored, not guessed", () => {
    // A stale/restored state, or a future kind this build does not know.
    const entries = sheetEntriesOf([
      { key: "a", name: SHEET_ROUTE },
      { key: "b", name: SHEET_ROUTE, params: { kind: "hologram" } },
      { key: "c", name: SHEET_ROUTE, params: { kind: 7 } },
    ]);
    expect(entries).toEqual([]);
  });

  test("the route name is the ONE constant, not a literal per call site", () => {
    expect(SHEET_ROUTE).toBe("Sheet");
  });
});

describe("drainPops — the lock drain empties the stack in ONE pass (S3)", () => {
  test("every key, top-down", () => {
    expect(drainPops(stack("commands", "outbox", "permission"))).toEqual(["a2", "a1", "a0"]);
  });

  test("an empty stack has nothing to drain", () => {
    expect(drainPops([])).toEqual([]);
  });

  test("its pops are planned pops: no swipe is reported for any of them", () => {
    const prev = stack("tools", "permission");
    // The screen pops all of them and keeps them as the pass's planned pops.
    expect(dismissedNatively(prev, [], drainPops(prev))).toEqual([]);
  });

  test("draining never touches `desired`: the same sheets re-push in order", () => {
    const desired = desiredStack({ user: "tools", outbox: true, permission: true });
    let actual = stack("tools", "outbox", "permission");
    for (const key of drainPops(actual)) {
      actual = actual.filter((e) => e.key !== key);
    }
    expect(actual).toEqual([]);
    const pushed: SheetKind[] = [];
    for (let i = 0; i < 10; i++) {
      const step = reconcile(desired, actual, SHOWN);
      if (step === null) break;
      expect(step.action).toBe("push");
      if (step.action !== "push") break;
      pushed.push(step.kind);
      actual = [...actual, { kind: step.kind, key: `r${i}` }];
    }
    expect(pushed).toEqual(["tools", "outbox", "permission"]);
  });

  test("while hidden the loop pops the top only — never a lower key", () => {
    // The screen applies this repeatedly (the keys are drained in one pass).
    const actual = stack("tools", "permission");
    const step = reconcile(["tools"], actual, HIDDEN);
    expect(step).toEqual({ action: "pop", key: "a1" });
  });
});

describe("sheetIdentity — what a detent is remembered against (S3)", () => {
  test("a user sheet is remembered by its KIND, not by a route key", () => {
    for (const kind of SHEET_KINDS) {
      if (kind === "permission") continue;
      expect(sheetIdentity(kind, "req-9")).toBeNull();
    }
  });

  test("the ask is remembered by ITS OWN id", () => {
    expect(sheetIdentity("permission", "req-9")).toBe("req-9");
    // No ask (the `returned` state): the kind's own slot, never another ask's.
    expect(sheetIdentity("permission", null)).toBeNull();
  });

  test("a re-delivered ask keeps the detent the person left it at (Step 0b L3)", () => {
    const memory = createDetentMemory();
    // The person dragged the ask of `req-9` to L.
    recordDetent(memory, "permission", sheetIdentity("permission", "req-9"), {
      index: 2,
      stable: true,
    });
    // On resume the link re-delivers the SAME ask: it re-opens at L.
    expect(openingDetent(memory, "permission", sheetIdentity("permission", "req-9"), CALM)).toBe(2);
    // A DIFFERENT ask opens at the spec's detent, not at the last ask's.
    expect(openingDetent(memory, "permission", sheetIdentity("permission", "req-10"), CALM)).toBe(
      SHEET_SPEC.permission.initial,
    );
  });
});

describe("recordDetent — only a STABLE change is remembered (S3)", () => {
  test("a stable change is remembered and clamped to the spec", () => {
    const memory = createDetentMemory();
    expect(recordDetent(memory, "tools", null, { index: 2, stable: true })).toBe(true);
    expect(rememberedDetent(memory, "tools", null)).toBe(2);
    recordDetent(memory, "tools", null, { index: 99, stable: true });
    expect(rememberedDetent(memory, "tools", null)).toBe(2);
  });

  test("a mid-drag (unstable) index is NOT remembered", () => {
    const memory = createDetentMemory();
    expect(recordDetent(memory, "tools", null, { index: 0, stable: false })).toBe(false);
    expect(rememberedDetent(memory, "tools", null)).toBeNull();
    // And it does not overwrite a remembered one either.
    recordDetent(memory, "tools", null, { index: 2, stable: true });
    expect(recordDetent(memory, "tools", null, { index: 0, stable: false })).toBe(false);
    expect(rememberedDetent(memory, "tools", null)).toBe(2);
  });
});

describe("askingParamUpdate — the ask's route says which ask, and whether it is blocked (D5)", () => {
  const OWNER = { computerId: "c1", sessionId: "s1" };
  const ask = (key: string, asking?: boolean, askId?: string) => ({
    key,
    name: SHEET_ROUTE,
    params: {
      computerId: "c1",
      sessionId: "s1",
      kind: "permission" as const,
      ...(asking === undefined ? {} : { asking }),
      ...(askId === undefined ? {} : { askId }),
    },
  });
  const ANSWERED = { asking: false, askId: "a1" };

  test("settling the ask is a keyed rewrite of the ask's own route", () => {
    // Mutation: `askingParamUpdate` always returns null → red.
    expect(askingParamUpdate([ask("k1", true, "a1")], OWNER, ANSWERED)).toEqual({
      key: "k1",
      params: { asking: false },
    });
  });

  test("a route that already says so is not rewritten (no render loop)", () => {
    expect(askingParamUpdate([ask("k1", false, "a1")], OWNER, ANSWERED)).toBeNull();
    expect(
      askingParamUpdate([ask("k1", true, "a1")], OWNER, { asking: true, askId: "a1" }),
    ).toBeNull();
  });

  test("a SECOND ask on the same route rewrites the id, so the note and detent follow it", () => {
    // The sheet presents the queued ask at once; a route still naming the first
    // one would key the note and the detent memory on an ask that is gone.
    expect(
      askingParamUpdate([ask("k1", true, "a1")], OWNER, { asking: true, askId: "a2" }),
    ).toEqual({ key: "k1", params: { asking: true, askId: "a2" } });
    // Settled AND a new id: both legs in one patch.
    expect(
      askingParamUpdate([ask("k1", true, "a1")], OWNER, { asking: false, askId: "a2" }),
    ).toEqual({ key: "k1", params: { asking: false, askId: "a2" } });
  });

  test("the TOP of our stack is the target, never a lower route", () => {
    const routes = [
      {
        key: "u1",
        name: SHEET_ROUTE,
        params: { computerId: "c1", sessionId: "s1", kind: "tools" },
      },
      ask("k2", true, "a1"),
    ];
    expect(askingParamUpdate(routes, OWNER, ANSWERED)?.key).toBe("k2");
  });

  test("another session's sheet is never rewritten, and no ask means nothing to do", () => {
    const other = {
      key: "o1",
      name: SHEET_ROUTE,
      params: { computerId: "c1", sessionId: "s2", kind: "permission", asking: true, askId: "a1" },
    };
    expect(askingParamUpdate([other], OWNER, ANSWERED)).toBeNull();
    expect(askingParamUpdate([], OWNER, ANSWERED)).toBeNull();
    expect(
      askingParamUpdate(
        [
          {
            key: "t1",
            name: SHEET_ROUTE,
            params: { computerId: "c1", sessionId: "s1", kind: "tools" },
          },
        ],
        OWNER,
        ANSWERED,
      ),
    ).toBeNull();
  });
});

describe("askRouteParams — the route is the only place a settled ask still has an id", () => {
  const OWNER = { computerId: "c1", sessionId: "s1" };
  test("reads back what the route says, and null when no ask route is up", () => {
    // The note must be forgotten under the id of the ask that EARNED it, after
    // the sheet is a `returned` reply and holds none (mutation: drop this reader
    // and forget under `askId` → the settled ask's note leaks).
    const route = {
      key: "k1",
      name: SHEET_ROUTE,
      params: {
        computerId: "c1",
        sessionId: "s1",
        kind: "permission" as const,
        asking: false,
        askId: "a1",
      },
    };
    expect(askRouteParams([route], OWNER)).toEqual({ asking: false, askId: "a1" });
    // Nothing pushed, another session's sheet, or a user sheet on top: no ask.
    expect(askRouteParams([], OWNER)).toBeNull();
    expect(
      askRouteParams([{ ...route, params: { ...route.params, sessionId: "s2" } }], OWNER),
    ).toBeNull();
    expect(
      askRouteParams(
        [
          {
            key: "t1",
            name: SHEET_ROUTE,
            params: { computerId: "c1", sessionId: "s1", kind: "tools" },
          },
        ],
        OWNER,
      ),
    ).toBeNull();
  });

  test("a route with no id reads as null, and asking defaults to false", () => {
    const route = {
      key: "k1",
      name: SHEET_ROUTE,
      params: { computerId: "c1", sessionId: "s1", kind: "permission" },
    };
    expect(askRouteParams([route], OWNER)).toEqual({ asking: false, askId: null });
  });
});

describe("askRouteId — the id an ask's route carries (S5)", () => {
  test("the daemon's id when there is one, else the sheet's own seq (never colliding)", () => {
    expect(askRouteId("ask-7", 3)).toBe("ask-7");
    expect(askRouteId(null, 3)).toBe("seq:3");
    // A numeric-looking requestId can never equal a local ask's id.
    expect(askRouteId("3", 3)).not.toBe(askRouteId(null, 3));
  });
});
