/**
 * New session from a project's session list
 * (docs/feat/mobile-project-new-session.md D2, D3, D5).
 *
 * The list side is driven through the REAL `reduce` / `initialSessionList`, so
 * what is pinned is the actual state machine's gate, not a hand-built object's.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDrawerNewSession } from "../src/drawer-new-session.ts";
import {
  CANT_REACH_REASON,
  CONNECTING_REASON,
  OFFLINE_REASON,
  openCreatedSession,
  projectNewSessionTap,
  projectNewSessionView,
} from "../src/project-new-session.ts";
import {
  type SessionListAction,
  type SessionListState,
  initialSessionList,
  reduce,
} from "../src/session-list.ts";

const idle = { creating: false, error: null };

const row = { sessionId: "s1", title: "one", updatedAt: 1 };

function run(state: SessionListState, ...actions: SessionListAction[]): SessionListState {
  return actions.reduce(reduce, state);
}

/** A refresh answered by one page of `sessions`. */
function answered(state: SessionListState, sessions: (typeof row)[] = [row]): SessionListState {
  const asked = reduce(state, { type: "refresh" });
  return reduce(asked, {
    type: "page",
    page: { sessions } as never,
    generation: asked.generation,
  });
}

/** A refresh that failed. */
function failed(state: SessionListState): SessionListState {
  const asked = reduce(state, { type: "refresh" });
  return reduce(asked, { type: "fail", error: "boom", generation: asked.generation });
}

function dimmed(list: SessionListState, reason: string): void {
  const view = projectNewSessionView(list, idle);
  expect(view).toEqual({
    enabled: false,
    busy: false,
    reason,
    error: null,
    accessibilityLabel: `New session, ${reason}`,
  });
  expect(projectNewSessionTap(view)).toBe("refuse");
}

function live(list: SessionListState): void {
  const view = projectNewSessionView(list, idle);
  expect(view).toEqual({
    enabled: true,
    busy: false,
    reason: null,
    error: null,
    accessibilityLabel: "New session",
  });
  expect(projectNewSessionTap(view)).toBe("create");
}

describe("projectNewSessionView", () => {
  test("the reasons are words (never colour alone)", () => {
    expect(CONNECTING_REASON).toBe("Connecting…");
    expect(OFFLINE_REASON).toBe("Offline — reconnecting");
    expect(CANT_REACH_REASON).toBe("Can't reach this computer");
  });

  test("never answered yet: dimmed, «Connecting…» (idle, then loading with no rows)", () => {
    dimmed(initialSessionList, CONNECTING_REASON);
    const loading = run(initialSessionList, { type: "refresh" });
    expect(loading.status).toBe("loading");
    dimmed(loading, CONNECTING_REASON);
  });

  test("an answered list is enabled, with or without rows", () => {
    live(answered(initialSessionList));
    live(answered(initialSessionList, []));
  });

  test("D2: a refresh of a list WITH rows keeps it enabled (no flicker)", () => {
    const refreshing = run(answered(initialSessionList), { type: "refresh" });
    expect(refreshing.pending).toBe("first");
    live(refreshing);
  });

  test("link down: dimmed «Offline — reconnecting»; link up and a page enables it again", () => {
    const down = run(answered(initialSessionList), { type: "link", up: false });
    expect(down.status).toBe("loaded");
    dimmed(down, OFFLINE_REASON);
    live(answered(run(down, { type: "link", up: true })));
  });

  test("a link that drops before any answer says offline, not connecting", () => {
    dimmed(run(initialSessionList, { type: "link", up: false }), OFFLINE_REASON);
  });

  test("a failed first read: «Can't reach this computer»; a retry that answers enables it", () => {
    const broken = failed(initialSessionList);
    expect(broken.status).toBe("failed");
    dimmed(broken, CANT_REACH_REASON);
    // The link coming back alone is no answer: the read is still failed.
    dimmed(run(broken, { type: "link", up: true }), CANT_REACH_REASON);
    live(answered(broken));
  });

  test("a failed refresh of a list with rows is stale: «Offline — reconnecting»", () => {
    const stale = failed(answered(initialSessionList));
    expect(stale.status).toBe("loaded");
    dimmed(stale, OFFLINE_REASON);
    live(answered(stale));
  });

  test("a create in flight: busy, not enabled, no reason; a second tap is ignored", () => {
    for (const list of [
      answered(initialSessionList),
      run(answered(initialSessionList), { type: "link", up: false }),
    ]) {
      const view = projectNewSessionView(list, { creating: true, error: null });
      expect(view).toEqual({
        enabled: false,
        busy: true,
        reason: null,
        error: null,
        accessibilityLabel: "New session",
      });
      expect(projectNewSessionTap(view)).toBe("ignore");
    }
  });

  test("D5: a failed create's text passes through, whatever the gate says", () => {
    const state = { creating: false, error: "This computer has too many sessions open." };
    expect(projectNewSessionView(answered(initialSessionList), state).error).toBe(state.error);
    expect(projectNewSessionView(initialSessionList, state).error).toBe(state.error);
  });
});

const APP_ROOT = join(import.meta.dir, "..");
// The REAL stack router the app's navigator runs, resolved through the app's
// own dependency chain (it is a transitive dependency).
const nativeEntry = Bun.resolveSync("@react-navigation/native", APP_ROOT);
const coreEntry = Bun.resolveSync("@react-navigation/core", dirname(nativeEntry));
const { StackRouter, CommonActions } = await import(
  Bun.resolveSync("@react-navigation/routers", dirname(coreEntry))
);

interface StackState {
  readonly index: number;
  readonly routes: readonly {
    readonly key: string;
    readonly name: string;
    readonly params?: { readonly sessionId?: string };
  }[];
}

/** A stack standing on the Sessions list, as the app's navigator holds it. */
function stackOnSessions() {
  const router = StackRouter({});
  const options = {
    routeNames: ["Sessions", "Session"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state: StackState = router.getInitialState(options);
  const list = state.routes[0]?.key;
  const apply = (action: unknown): void => {
    state = router.getStateForAction(state, action, options);
  };
  return {
    navigate: (sessionId: string) => apply(CommonActions.navigate("Session", { sessionId })),
    back: () => apply(CommonActions.goBack()),
    /** The list screen's `navigation.isFocused()`. */
    screen: { isFocused: (): boolean => state.routes[state.index]?.key === list },
    shown: (): string[] => state.routes.map((r) => r.params?.sessionId ?? r.name),
  };
}

/** The Sessions route's flow, over a create that settles when `settle` is called. */
function pendingCreate() {
  const stack = stackOnSessions();
  const gate: { release: () => void } = { release: () => {} };
  const flow = createDrawerNewSession({
    mint: () => "NEW",
    create: () =>
      new Promise((resolve) => {
        gate.release = () => resolve({ ok: true });
      }),
    opened: (_, id) => openCreatedSession(stack.screen, () => stack.navigate(id)),
  });
  const started = flow.start("mac", true);
  const settle = async (): Promise<void> => {
    gate.release();
    await started;
  };
  return { stack, flow, settle };
}

describe("a create that settles opens its session only over its own list", () => {
  test("the list still in front: the new session opens", async () => {
    const { stack, settle } = pendingCreate();
    await settle();
    expect(stack.shown()).toEqual(["Sessions", "NEW"]);
  });

  test("a row opened meanwhile stays: the new session does not replace it", async () => {
    const { stack, flow, settle } = pendingCreate();
    stack.navigate("ROW-X");
    await settle();
    expect(stack.shown()).toEqual(["Sessions", "ROW-X"]);
    // The create itself finished: back on the list, the button is live again.
    expect(flow.state()).toEqual(idle);
  });

  test("back on the list before it settles: the tapped create opens", async () => {
    const { stack, settle } = pendingCreate();
    stack.navigate("ROW-X");
    stack.back();
    await settle();
    expect(stack.shown()).toEqual(["Sessions", "NEW"]);
  });

  test("the Sessions route opens through that guard, with its own navigation", () => {
    // `App.tsx` is not importable from Bun, so the wiring is pinned from source.
    const app = readFileSync(join(APP_ROOT, "App.tsx"), "utf8");
    expect(app).toMatch(
      /onCreated=\{\(sessionId\) =>\s*openCreatedSession\(navigation, \(\) =>\s*navigation\.navigate\("Session"/,
    );
  });
});
