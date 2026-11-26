/**
 * Shared containers in the real `App`
 * (docs/feat/session-apps-container-ports.md S4): `/previews` opens on the feed,
 * `c` asks for the link and copies it (never shown on screen), `s` stops, and
 * the share dialog offers the secret link first and public second.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import type { PreviewRow } from "@tentacle/protocol";
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

const URL = "https://abcdefghijklmnop.apps.example.so/";
const SECRET_URL = `${URL}__tentacle/cap/s3cr3t`;
const ROW: PreviewRow = {
  id: "p1",
  containerId: "c".repeat(64),
  engine: "podman",
  name: "web",
  image: "nginx",
  containerPort: 80,
  createdAt: 1,
  link: { url: URL, state: "up", public: false },
};

function mount() {
  const asked: string[] = [];
  const stopped: string[] = [];
  const copied: string[] = [];
  let listener: ((rows: readonly PreviewRow[]) => void) | null = null;
  const permissions = new PermissionBroker();
  const session = (): SessionController => ({
    ...inertSession(),
    async *send() {},
    ownsTurn: () => true,
    onPreviews: (l) => {
      listener = l;
      l([ROW]);
      return () => {
        listener = null;
      };
    },
    previewLink: async (id) => {
      asked.push(id);
      return { ok: true, url: SECRET_URL };
    },
    previewStop: async (id) => {
      stopped.push(id);
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
      clipboard={async (text) => {
        copied.push(text);
      }}
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
    asked,
    stopped,
    copied,
    permissions,
    report: (rows: readonly PreviewRow[]) => listener?.(rows),
  };
}

describe("/previews in the real App", () => {
  test("lists, copies the secret link without showing it, stops, follows the daemon", async () => {
    const { app, frame, keys, asked, stopped, copied, report } = mount();
    await delay(30);
    await keys("/previews", "\r");
    await until(() => frame().includes("Previews (1)"), frame);
    expect(frame()).toContain("secret link · up · web port 80");
    expect(frame()).toContain(URL);
    await keys("c");
    await until(() => copied.length === 1, frame);
    expect(asked).toEqual(["p1"]);
    expect(copied).toEqual([SECRET_URL]);
    await keys("s");
    await until(() => stopped.length === 1, frame);
    expect(stopped).toEqual(["p1"]);
    expect(frame()).toContain("Previews (1)");
    report([]);
    await until(() => frame().includes("No shared containers"), frame);
    await keys("\u001b");
    await until(() => frame().includes("Copied the secret link of web"), frame);
    expect(frame()).not.toContain("s3cr3t");
    app.unmount();
  });

  test("the share dialog: secret link first, public second, never «always»", async () => {
    const { app, frame, keys, permissions } = mount();
    await delay(30);
    const answers: PermissionResponse[] = [];
    const ask = () =>
      void permissions
        .request(
          {
            kind: "container_share",
            tool: "container_share",
            level: "ask",
            title: "Put container web port 80/tcp on the INTERNET behind a secret link?",
            input: {},
          },
          { turnId: "own-1" },
        )
        .then((r) => answers.push(r));
    ask();
    await until(() => frame().includes("Share with a secret link"), frame);
    expect(frame()).toContain("Share PUBLICLY: anyone with the address");
    expect(frame().indexOf("Share with a secret link")).toBeLessThan(
      frame().indexOf("Share PUBLICLY"),
    );
    expect(frame()).not.toContain("don't ask again");
    // The pre-selected answer (Enter) is the secret link.
    await delay(ARM_MS + 60);
    await keys("\r");
    await until(() => answers.length === 1, frame);
    expect(answers[0]).toEqual({ allowed: true, scope: "once" });
    // Public only by moving to it.
    ask();
    await until(() => frame().includes("Share PUBLICLY"), frame);
    await delay(ARM_MS + 60);
    await keys("\u001b[B", "\r");
    await until(() => answers.length === 2, frame);
    expect(answers[1]).toEqual({ allowed: true, scope: "once", choice: "public" });
    // The quick `y` is the secret link too; `a` ("always" elsewhere, the second
    // row) never makes it public.
    ask();
    await until(() => frame().includes("Share PUBLICLY"), frame);
    await delay(ARM_MS + 60);
    await keys("a");
    expect(answers).toHaveLength(2);
    await keys("y");
    await until(() => answers.length === 3, frame);
    expect(answers[2]).toEqual({ allowed: true, scope: "once" });
    app.unmount();
  });
});
