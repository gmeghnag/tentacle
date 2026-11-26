/**
 * The `/apps` panel's pure half (docs/feat/session-apps-publish.md D10/D12):
 * rows, keys, the status words, the quit warning. A state this build does not
 * know is never shown as up.
 */
import { describe, expect, test } from "bun:test";
import type { AppRow } from "@tentacle/protocol";
import {
  appStateOf,
  appStopNotice,
  appsKey,
  appsMove,
  appsQuitText,
  appsStatusLabel,
  appsView,
  liveAppCount,
} from "../src/apps-view.ts";
import { quitCommandStep, quitConfirmText } from "../src/commands.ts";
import { buildPermissionChoices } from "../src/permission-ui.ts";

const row = (i: number, over: Partial<AppRow> = {}): AppRow => ({
  app: `app${i}`,
  url: `https://app${i}.apps.example.so/`,
  artifactId: "page",
  version: 1,
  title: `Page ${i}`,
  state: "up",
  since: 1,
  publishedAt: 1,
  ...over,
});

describe("appsView", () => {
  test("two rows per app: state and title, then URL and reason", () => {
    const view = appsView([row(1), row(2, { state: "down", reason: "publish again" })], 1, 80, 20);
    expect(view.title).toBe("Apps (2)");
    expect(view.rows.map((r) => r.text)).toEqual([
      "  up · Page 1",
      "    https://app1.apps.example.so/",
      "▸ down · Page 2",
      "    https://app2.apps.example.so/ — publish again",
    ]);
    expect(view.hint).toContain("s stop");
  });

  test("an unknown state is `unknown`, never `up`; rows never exceed the width", () => {
    expect(appStateOf("weird")).toBe("unknown");
    const view = appsView([row(1, { state: "weird", title: "x".repeat(200) })], 0, 40, 20);
    expect(view.rows[0]?.text.startsWith("▸ unknown · ")).toBe(true);
    for (const line of view.rows) expect(line.text.length).toBeLessThanOrEqual(40);
  });

  test("not reported and none are different claims", () => {
    expect(appsView(undefined, 0, 80, 20).rows[0]?.text).toContain("not reported");
    expect(appsView([], 0, 80, 20).rows[0]?.text).toContain("No published apps");
  });

  test("a long list is windowed by whole apps", () => {
    const view = appsView(
      Array.from({ length: 9 }, (_, i) => row(i)),
      8,
      80,
      6,
    );
    expect(view.rows).toHaveLength(6);
    expect(view.start).toBe(6);
    expect(view.hint).toContain("7–9 of 9");
  });

  test("keys and moves", () => {
    expect(appsKey("s", {})).toBe("stop");
    expect(appsKey("x", {})).toBe("none");
    expect(appsKey("", { escape: true })).toBe("close");
    expect(appsMove(0, "up", 3)).toBe(2);
    expect(appsMove(2, "down", 3)).toBe(0);
    expect(appsMove(5, "down", 0)).toBe(0);
  });
});

describe("the status line and the stop notice", () => {
  test("`1 app`, `2 apps`, `app down`", () => {
    expect(appsStatusLabel(undefined)).toBeNull();
    expect(appsStatusLabel([])).toBeNull();
    expect(appsStatusLabel([row(1)])).toBe("1 app");
    expect(appsStatusLabel([row(1), row(2, { state: "renewing" })])).toBe("2 apps");
    expect(appsStatusLabel([row(1), row(2, { state: "down" })])).toBe("app down");
    expect(appsStatusLabel([row(1, { state: "removed" }), row(2, { state: "weird" })])).toBe(
      "2 apps down",
    );
  });

  test("the stop notice says what happened", () => {
    expect(appStopNotice("a", { ok: true })).toBe("_Stopped a._");
    expect(appStopNotice("a", { ok: false, reason: "no app" })).toBe("_a was not stopped: no app_");
  });
});

describe("quitting with live apps", () => {
  const base = {
    running: false,
    exitPending: false,
    foreign: false,
    detaches: false,
    endsSession: false,
    others: 0,
    agents: 0,
    confirmed: false,
  };

  test("only a quit that ends the session asks", () => {
    expect(liveAppCount([row(1), row(2, { state: "down" })])).toBe(1);
    expect(quitCommandStep({ ...base, apps: 1 })).toBe("confirm");
    expect(quitCommandStep({ ...base, apps: 1, confirmed: true })).toBe("exit");
    expect(quitCommandStep({ ...base, apps: 1, detaches: true })).toBe("exit");
    expect(quitCommandStep({ ...base, apps: 0 })).toBe("exit");
  });

  test("the warning, alone and beside other losses, stays one row", () => {
    expect(appsQuitText(0)).toBeNull();
    expect(quitConfirmText({ others: 0, agents: 0, names: [], apps: 1 })).toBe(
      "quitting takes 1 live app offline — quit? (y/N)",
    );
    const jobs = quitConfirmText({ others: 0, agents: 0, names: [], jobs: 1, apps: 2 });
    expect(jobs).toContain("1 background shell job");
    expect(jobs).toContain("2 apps go offline");
    const long = quitConfirmText({
      others: 2,
      agents: 4,
      names: ["sa-1", "sa-2", "sa-3", "sa-4"],
      jobs: 3,
      apps: 2,
    });
    expect(long).toContain("2 live apps offline");
    expect(long.endsWith("(y/N)")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(78);
  });
});

test("a publish ask offers «Publish once» or «No», never «always»", () => {
  const options = buildPermissionChoices({
    kind: "app_publish",
    tool: "app_publish",
    level: "ask",
    title: "Publish?",
    input: {},
    suggestion: { prefix: "x" },
  });
  expect(options.map((o) => o.label)).toEqual(["Publish once", "No"]);
  expect(options.some((o) => o.response.scope === "session")).toBe(false);
});
