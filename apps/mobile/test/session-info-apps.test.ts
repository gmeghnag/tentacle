/**
 * The phone's «Apps» section (docs/feat/session-apps-publish.md D10): the
 * view-model, Stop through the controller, and a publish sheet that offers no
 * «always». The pixels are the simulator sweep's.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import type { AppRow, AppUnpublishResult } from "@tentacle/protocol";
import { sheetOptions } from "../src/permission-sheet.ts";
import { type InfoApps, type InfoPort, createSessionInfo } from "../src/session-info-controller.ts";
import { type InfoFacts, appsSection, sessionInfoView } from "../src/session-info.ts";

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

const loading = { state: "loading" } as const;
const facts = (over: Partial<InfoFacts> = {}): InfoFacts => ({
  phase: "open",
  link: "up",
  title: "t",
  computerName: "Mac",
  daemon: undefined,
  mcp: loading,
  skills: loading,
  context: loading,
  entry: loading,
  autoAccept: false,
  capabilities: { phase: "unsupported", state: undefined, changedBy: {}, error: null },
  now: 1,
  ...over,
});

describe("appsSection", () => {
  test("no report (an older daemon, apps off): no section, never «none»", () => {
    expect(appsSection(facts())).toBeNull();
    expect(sessionInfoView(facts()).sections.map((s) => s.id)).not.toContain("apps");
  });

  test("rows: title, the state as a word, the address, Copy and Stop", () => {
    const view = sessionInfoView(
      facts({
        apps: {
          rows: [row(1), row(2, { state: "down", reason: "publish again" })],
          error: null,
        },
      }),
    );
    const section = view.sections.find((s) => s.id === "apps");
    expect(section?.title).toBe("Apps");
    expect(section?.phase).toBe("ready");
    expect(section?.rows.map((r) => r.subtitle)).toEqual([
      "up\nhttps://app1.apps.example.so/",
      "down — publish again\nhttps://app2.apps.example.so/",
    ]);
    expect(section?.rows[0]?.app).toMatchObject({
      url: "https://app1.apps.example.so/",
      stop: "app1",
    });
  });

  test("an unknown state is never `up`", () => {
    const section = appsSection(
      facts({ apps: { rows: [row(1, { state: "weird" })], error: null } }),
    );
    expect(section?.rows[0]?.subtitle?.startsWith("unknown")).toBe(true);
    expect(section?.rows[0]?.tone).toBe("offline");
  });

  test("offline: Copy stays, Stop cannot be sent", () => {
    const section = appsSection(facts({ link: "down", apps: { rows: [row(1)], error: null } }));
    expect(section?.dim).toBe(true);
    expect(section?.rows[0]?.app?.url).toBe("https://app1.apps.example.so/");
    expect(section?.rows[0]?.app?.stop).toBeUndefined();
  });

  test("empty, not open, and a refused stop's reason", () => {
    expect(appsSection(facts({ apps: { rows: [], error: null } }))?.phase).toBe("empty");
    expect(appsSection(facts({ phase: "failed", apps: { rows: [], error: null } }))?.phase).toBe(
      "not-open",
    );
    expect(appsSection(facts({ apps: { rows: [row(1)], error: "no app" } }))?.footer).toBe(
      "no app",
    );
  });
});

describe("the controller", () => {
  function rig(answer: AppUnpublishResult = { ok: true }) {
    const stopped: string[] = [];
    let listener: ((rows: readonly AppRow[] | undefined) => void) | null = null;
    const apps: InfoApps = {
      current: () => [row(1)],
      onChange: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      stop: async (app) => {
        stopped.push(app);
        return answer;
      },
    };
    const never = new Promise<never>(() => {});
    const port: InfoPort = {
      daemon: () => undefined,
      now: () => 1,
      computerName: () => "Mac",
      title: () => "t",
      phase: () => "open",
      sessionId: "s",
      mcpStatus: () => never,
      sessionList: () => never,
      session: () => ({ skills: () => never, context: () => never, apps }),
    };
    const info = createSessionInfo(port);
    void info.open();
    const section = () => info.state().view.sections.find((s) => s.id === "apps");
    return {
      info,
      stopped,
      section,
      report: (rows: readonly AppRow[]) => listener?.(rows),
      following: () => listener !== null,
    };
  }

  test("Stop calls the session; the row leaves only on the daemon's list", async () => {
    const r = rig();
    expect(r.section()?.rows).toHaveLength(1);
    await r.info.stopApp("app1");
    expect(r.stopped).toEqual(["app1"]);
    expect(r.section()?.rows).toHaveLength(1);
    r.report([]);
    expect(r.section()?.phase).toBe("empty");
    r.info.close();
    expect(r.following()).toBe(false);
  });

  test("a refusal keeps the row and shows why", async () => {
    const r = rig({ ok: false, reason: "no app" });
    await r.info.stopApp("app1");
    expect(r.section()?.footer).toBe("no app");
    expect(r.section()?.rows).toHaveLength(1);
    r.info.close();
  });
});

test("a publish sheet offers «Publish once» or «No», never «always»", () => {
  const ask: PermissionRequest = {
    kind: "app_publish",
    tool: "app_publish",
    level: "ask",
    title: "Publish?",
    input: {},
    suggestion: { prefix: "x" },
  };
  expect(sheetOptions(ask).map((o) => [o.optionId, o.label])).toEqual([
    ["allow_once", "Publish once"],
    ["reject_once", "No"],
  ]);
});
