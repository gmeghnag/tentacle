/**
 * docs/fix/mobile-push-tap-open.md Design 2: a tap that arrives before the
 * navigator is ready (a cold start from a banner) is PARKED and replayed once.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRouteQueue } from "../src/notification-route-queue.ts";

const SESSION = { computerId: "c1", sessionId: "s1", title: "t", archived: false };

function setup(): { sent: unknown[]; q: ReturnType<typeof createRouteQueue<unknown>> } {
  const sent: unknown[] = [];
  return { sent, q: createRouteQueue<unknown>((r) => sent.push(r)) };
}

describe("createRouteQueue", () => {
  test("a route before ready is not lost: replayed once at ready", () => {
    const { sent, q } = setup();
    q.route(SESSION, false);
    expect(sent).toEqual([]);
    q.flush(true);
    q.flush(true);
    expect(sent).toEqual([SESSION]);
  });
  test("the 'computers' route is parked too", () => {
    const { sent, q } = setup();
    q.route("computers", false);
    q.flush(true);
    expect(sent).toEqual(["computers"]);
  });
  test("two parks before ready: the last wins, one navigation", () => {
    const { sent, q } = setup();
    q.route("computers", false);
    q.route(SESSION, false);
    q.flush(true);
    expect(sent).toEqual([SESSION]);
  });
  test("flush while not ready keeps it parked", () => {
    const { sent, q } = setup();
    q.route(SESSION, false);
    q.flush(false);
    expect(sent).toEqual([]);
    q.flush(true);
    expect(sent).toEqual([SESSION]);
  });
  test("a route when ready goes straight through", () => {
    const { sent, q } = setup();
    q.route(SESSION, true);
    expect(sent).toEqual([SESSION]);
    q.flush(true);
    expect(sent).toEqual([SESSION]);
  });
});

describe("App wiring", () => {
  const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
  test("navigate goes through the queue and onReady flushes it", () => {
    expect(app).toContain("createRouteQueue");
    expect(app).toContain("routeQueue.route(");
    expect(app).toContain("routeQueue.flush(navigationRef.isReady())");
    expect(app).toContain("onReady={onNavigatorReady}");
  });
});
