/**
 * docs/feat/mobile-notifications.md N8: the dev-only injection channel. Pure over
 * its filesystem functions, so the consume-once rule and the refusal to guess at
 * a malformed file are pinned without a simulator.
 */
import { describe, expect, test } from "bun:test";
import { NOTIFY_RESPONSE_FILE, takeInjectedResponse } from "../src/notification-dev-inject.ts";

function io(initial: string | undefined) {
  let content = initial;
  const removed: string[] = [];
  return {
    get content() {
      return content;
    },
    removed,
    deps: {
      read: () => content,
      remove: (_path: string) => {
        removed.push(_path);
        content = undefined;
      },
    },
  };
}

describe("takeInjectedResponse", () => {
  test("nothing there: undefined, nothing removed", () => {
    const h = io(undefined);
    expect(takeInjectedResponse("/f", h.deps)).toBeUndefined();
    expect(h.removed).toEqual([]);
  });

  test("a response is returned once, then consumed (a second poll sees nothing)", () => {
    // Mutation: do not remove it → the app answers the same notification forever.
    const h = io(JSON.stringify({ actionId: "tentacle.approve", userInfo: { tp: { v: 1 } } }));
    expect(takeInjectedResponse("/f", h.deps)).toEqual({
      actionId: "tentacle.approve",
      userInfo: { tp: { v: 1 } },
    });
    expect(h.removed).toEqual(["/f"]);
    expect(takeInjectedResponse("/f", h.deps)).toBeUndefined();
  });

  test("a malformed file is consumed and refused (never retried forever)", () => {
    for (const bad of ["not json", "null", "{}", '{"actionId": 3}']) {
      const h = io(bad);
      expect(takeInjectedResponse("/f", h.deps)).toBeUndefined();
      expect(h.removed).toEqual(["/f"]);
    }
  });

  test("the reply text rides through when it is a string", () => {
    const h = io(JSON.stringify({ actionId: "tentacle.reply", userInfo: {}, userText: "use bun" }));
    expect(takeInjectedResponse("/f", h.deps)).toEqual({
      actionId: "tentacle.reply",
      userInfo: {},
      userText: "use bun",
    });
  });

  test("the harness file name is the one this module reads", () => {
    expect(NOTIFY_RESPONSE_FILE).toBe("Library/Caches/notify-respond.json");
  });
});
