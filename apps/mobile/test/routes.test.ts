/** Route types and the launch decision (docs/feat/mobile-app-shell.md). */
import { describe, expect, test } from "bun:test";
import { type RootStackParams, initialRoute, routeForStoreError } from "../src/routes.ts";

describe("initialRoute", () => {
  test("no computer to show → the pairing placeholder", () => {
    expect(initialRoute([])).toBe("Pair");
  });

  test("any computer → the computers list", () => {
    expect(initialRoute([{ id: "0123456789abcdef", name: "MacBook" }])).toBe("Computers");
  });
});

describe("routeForStoreError", () => {
  test("no failure → Pair (a fresh install really has nothing paired)", () => {
    expect(routeForStoreError(undefined)).toBe("Pair");
  });

  test("a store that cannot be READ goes to Computers, never Pair (F-K3/F-K4)", () => {
    // Routing to `Pair` would read as "nothing is paired" and invite a person to
    // pair over a store a NEWER build wrote — and a write there could erase it.
    expect(routeForStoreError(new Error("unreadable"))).toBe("Computers");
  });
});

describe("the Pair route's params (11b.1)", () => {
  test("`again` names the computer a re-pair replaces; it is optional", () => {
    // The type is the contract: `Pair` takes `{ again?, againName? } | undefined`.
    const plain: RootStackParams["Pair"] = undefined;
    const again: RootStackParams["Pair"] = { again: "0123456789abcdef", againName: "MacBook" };
    expect(plain).toBeUndefined();
    expect(again?.again).toBe("0123456789abcdef");
  });
});

describe("the workflow routes (docs/feat/workflows-ui.md D4)", () => {
  test("WorkflowRuns names the computer; the session it came from is optional", () => {
    const fromHub: RootStackParams["WorkflowRuns"] = {
      computerId: "0123456789abcdef",
      name: "MacBook",
      sessionId: "s1",
    };
    const bare: RootStackParams["WorkflowRuns"] = {
      computerId: "0123456789abcdef",
      name: "MacBook",
    };
    expect(fromHub.sessionId).toBe("s1");
    expect(bare.sessionId).toBeUndefined();
  });

  test("WorkflowRun names the run and the session that owns it", () => {
    const run: RootStackParams["WorkflowRun"] = {
      computerId: "0123456789abcdef",
      sessionId: "s1",
      runId: "wf-1",
      title: "task",
    };
    expect(run.runId).toBe("wf-1");
  });

  test("WorkflowStart names the computer and the session the run starts in (slice 5b)", () => {
    // A type pin, not a behaviour: the catalogue is validated against THAT
    // session's models, so both params are required (`tsc` refuses a missing one).
    const start: RootStackParams["WorkflowStart"] = {
      computerId: "0123456789abcdef",
      sessionId: "s1",
    };
    expect(start.sessionId).toBe("s1");
  });
});

describe("the Settings route (docs/feat/mobile-lock.md D6)", () => {
  test("it takes no params", () => {
    // The type is the contract: `Settings` is `undefined`, like `Computers`.
    const params: RootStackParams["Settings"] = undefined;
    expect(params).toBeUndefined();
  });
});
