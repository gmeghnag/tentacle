/**
 * docs/feat/session-apps-publish.md fix round 1: the controller the TUI gets
 * from the WORKER runtime (plain `tentacle`) carries the session's published
 * pages and their Stop — `onApps` / `unpublishApp` — through a real
 * `Connection` and `createLocalRuntime` with the worker's trust bits. The
 * persisting wrapper dropped them, so `/apps`, the status words and the quit
 * warning never saw an app there.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { appsRig } from "../../daemon/test/support/apps-host.ts";
import { WORKER_TRUST, createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("the worker runtime's controller reports the session's apps and stops one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apps-runtime-"));
  const rig = appsRig();
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, rig.host);
  const runtime = await createLocalRuntime({
    ...WORKER_TRUST,
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {}),
    cwd: dir,
    model: "m",
    resume: null,
  });
  try {
    const controller = runtime.createSession();
    for await (const _ of controller.send("go")) {
      // drain
    }
    const seen: string[][] = [];
    if (!controller.onApps) throw new Error("the runtime's controller has no onApps");
    controller.onApps((rows) => seen.push(rows.map((r) => r.app)));
    const id = controller.sessionId;
    if (!id) throw new Error("the session did not open");
    const row = await rig.publish(id);
    await until(() => seen.at(-1)?.[0] === row.app);

    if (!controller.unpublishApp) throw new Error("the runtime's controller has no unpublishApp");
    expect(await controller.unpublishApp(row.app)).toEqual({ ok: true });
    await until(() => seen.at(-1)?.length === 0);
    expect(rig.api.calls).toContain(`remove ${row.app}`);
  } finally {
    runtime.dispose();
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});
