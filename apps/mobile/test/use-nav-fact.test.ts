/**
 * docs/fix/mobile-fluidity-e2e.md (flow 44), the ROOT CAUSE in real React: a
 * render that reads a changed value from OUTSIDE React while no hook's state
 * changed is bailed out — its effects are dropped but their new deps are kept,
 * so they never run. `useNavFact` must make the navigator's facts React state.
 * Run on Ink's React 18 (the only renderer in the tree; same bailout rule).
 */
import { describe, expect, test } from "bun:test";
import { render } from "../../../packages/tui/node_modules/ink-testing-library/build/index.js";
import { Text } from "../../../packages/tui/node_modules/ink/build/index.js";
import { type NavFactHooks, useNavFact } from "../src/use-nav-fact.ts";

// Ink's own React: it ships no types at that path, so the app's describe it.
const { createElement, useCallback, useEffect, useState, useSyncExternalStore } =
  require("../../../packages/tui/node_modules/react/index.js") as typeof import("react");

const HOOKS: NavFactHooks = { useCallback, useSyncExternalStore };

const until = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

function mount() {
  let top = "landing";
  const listeners = new Set<() => void>();
  const navigation = {
    getState: () => top,
    addListener: (_type: "state", listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const renders: string[] = [];
  const effects: string[] = [];
  let setOther: (n: number) => void = () => {};
  function Screen() {
    const [other, set] = useState(0);
    setOther = set;
    const fact = useNavFact(navigation, (state: string) => state, HOOKS);
    renders.push(`${other} ${fact}`);
    useEffect(() => {
      effects.push(fact);
    }, [fact]);
    return createElement(Text, null, `${other} ${fact}`);
  }
  const app = render(createElement(Screen));
  return {
    app,
    renders,
    effects,
    set: (n: number) => setOther(n),
    commit: (next: string) => {
      top = next;
    },
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    listeners,
  };
}

describe("useNavFact", () => {
  test("a state-less render before the navigator's notify still runs the dependent effect", async () => {
    const screen = mount();
    await until("mount", () => screen.effects.length === 1 && screen.listeners.size === 1);
    screen.set(1);
    await until("the first update", () => screen.app.lastFrame() === "1 landing");

    // The navigator committed the push; its listeners have not been told yet.
    screen.commit("run");
    const before = screen.renders.length;
    screen.set(1); // the same value: React renders, finds nothing changed
    await until("the same-value render", () => screen.renders.length > before);
    screen.notify();
    screen.set(2);
    await until("the last update", () => screen.app.lastFrame() === "2 run");

    expect(screen.effects).toEqual(["landing", "run"]);
    screen.app.unmount();
  });

  test("a navigator notify alone re-renders, and unmount unsubscribes", async () => {
    const screen = mount();
    await until("mount", () => screen.listeners.size === 1);
    screen.commit("run");
    screen.notify();
    await until("the push", () => screen.effects.includes("run"));
    expect(screen.app.lastFrame()).toBe("0 run");
    screen.app.unmount();
    await until("unsubscribe", () => screen.listeners.size === 0);
  });
});
