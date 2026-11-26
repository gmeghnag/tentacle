/**
 * Session apps in the real `App` (docs/feat/session-apps-publish.md D10):
 * `/apps` opens on the feed, `s` sends the stop, the status line says it, and
 * the publish dialog shows two answers only.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import type { AppRow } from "@tentacle/protocol";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { ARM_MS } from "../src/permission-reply.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`never held:\n${what()}`);
    await delay(5);
  }
}

const ROW: AppRow = {
  app: "abcdefghijklmnop",
  url: "https://abcdefghijklmnop.apps.example.so/",
  artifactId: "page",
  version: 1,
  title: "Demo page",
  state: "up",
  since: 1,
  publishedAt: 1,
};

function mount() {
  const stopped: string[] = [];
  let listener: ((rows: readonly AppRow[]) => void) | null = null;
  const permissions = new PermissionBroker();
  const session = (): SessionController => ({
    ...inertSession(),
    ownsTurn: () => true,
    onApps: (l) => {
      listener = l;
      l([ROW]);
      return () => {
        listener = null;
      };
    },
    unpublishApp: async (app) => {
      stopped.push(app);
      return { ok: true };
    },
  });
  const app = render(
    <App
      createSession={session}
      permissions={permissions}
      model="m"
      cwd="/tmp/work"
      columns={100}
    />,
  );
  const frame = () => app.lastFrame() ?? "";
  const keys = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      app.stdin.write(chunk);
      await delay(20);
    }
  };
  return {
    app,
    frame,
    keys,
    stopped,
    permissions,
    report: (rows: readonly AppRow[]) => listener?.(rows),
  };
}

describe("/apps in the real App", () => {
  test("the status line says it; `/apps` opens on the feed; `s` stops; the row follows the daemon", async () => {
    const { app, frame, keys, stopped, report } = mount();
    await until(() => frame().includes("1 app"), frame);
    await keys("/apps", "\r");
    await until(() => frame().includes("Apps (1)"), frame);
    expect(frame()).toContain("up · Demo page");
    expect(frame()).toContain(ROW.url);
    await keys("s");
    await until(() => stopped.length === 1, frame);
    expect(stopped).toEqual([ROW.app]);
    // No local echo: the row stays until the daemon's list says otherwise.
    expect(frame()).toContain("Apps (1)");
    report([{ ...ROW, state: "down", reason: "publish again" }]);
    await until(() => frame().includes("down · Demo page"), frame);
    expect(frame()).toContain("app down");
    report([]);
    await until(() => frame().includes("No published apps"), frame);
    app.unmount();
  });

  test("the publish dialog offers «Publish once» or «No», nothing else", async () => {
    const { app, frame, keys, permissions } = mount();
    await delay(30);
    const answers: PermissionResponse[] = [];
    void permissions
      .request(
        {
          kind: "app_publish",
          tool: "app_publish",
          level: "ask",
          title: 'Publish "Demo page" as a public web page?',
          detail: "Anyone with the link can open it until this session ends",
          input: {},
        },
        { turnId: "own-1" },
      )
      .then((r) => answers.push(r));
    await until(() => frame().includes("Publish once"), frame);
    expect(frame()).toContain("as a public web page?");
    expect(frame()).toContain("No");
    expect(frame()).not.toContain("don't ask again");
    await delay(ARM_MS + 60);
    await keys("y");
    await until(() => answers.length === 1, frame);
    expect(answers).toEqual([{ allowed: true, scope: "once" }]);
    app.unmount();
  });
});
