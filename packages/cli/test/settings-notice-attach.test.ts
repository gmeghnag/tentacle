// docs/feat/config-carry.md, round 2 (F1): the drift notice through the real
// attach seams: `podSessionHost` (the real overlay) ↔ `createLocalRuntime`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import type { ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore, type SessionHost } from "@tentacle/daemon";
import type { SessionSettings } from "@tentacle/protocol";
import { createChannelPair } from "@tentacle/transport";
import { loadConfig } from "../src/config.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import * as serve from "../src/serve.ts";
import { SessionSaver } from "../src/session-saver.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const UID = "11111111-2222-4333-8444-555555555555";

describe("the settings notice through the real attach", () => {
  let root: string;
  let seq = 0;
  const fresh = async (): Promise<string> => mkdtemp(join(root, `d${seq++}-`));
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "notice-attach-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A resident: one host that outlives each laptop connection. */
  async function residentHost(file: unknown = {}): Promise<SessionHost> {
    const configDir = await fresh();
    await writeFile(join(configDir, "config.jsonc"), JSON.stringify(file));
    const config = await loadConfig({
      configDir,
      cwd: await fresh(),
      scaffold: false,
      env: { HOME: await fresh() },
      podDaemon: true,
    });
    return serve.podSessionHost(config, undefined, { modelProxy: true });
  }

  /** A laptop: the runtime `run`, `attach` and the relay all build. */
  async function laptop(
    host: SessionHost,
    sessionSettings: SessionSettings,
    resume: SessionRecord | null = null,
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host, () => {}, { servesModel: true });
    const notices: string[] = [];
    const store = new LogSessionStore(await fresh());
    const saver = new SessionSaver(store, () => {});
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: new PermissionBroker(),
      saver,
      cwd: "/work",
      model: "m",
      resume,
      modelProvider: new Scripted(),
      sessionId: UID,
      sessionSettings,
      daemonKind: "container",
      notify: (line) => notices.push(line),
    });
    return { runtime, notices, saver, store };
  }

  /** A run: creates the session with `settings`, ends its turn, leaves with a detach. */
  async function runThenLeave(host: SessionHost, settings: SessionSettings) {
    const run = await laptop(host, settings);
    for await (const _event of run.runtime.createSession().send("hello")) {
      // drain
    }
    await run.runtime.release();
    await run.saver.drain();
    const loaded = await run.store.load(UID);
    if (loaded.status !== "ok") {
      throw new Error(`no saved record: ${loaded.status}`);
    }
    return loaded.record;
  }

  const DRIFT = "Session settings: ";

  test("join (`attachTo`): a live session created with 3, a laptop on 5: the notice", async () => {
    const host = await residentHost();
    const record = await runThenLeave(host, { maxIterations: 3 });
    const tui = await laptop(host, { maxIterations: 5 }, record);
    expect(await tui.runtime.attachTo(UID, record)).toBe(true);
    expect(tui.notices.join("\n")).toContain(DRIFT);
    await tui.runtime.release();
  });

  test("a lazy session tells nothing before its first prompt: why a plain attach calls `attachTo`", async () => {
    // The live FAIL, as it was: `main.ts`'s plain path left the session lazy, so
    // no open, no report. The call itself is pinned in `main.test.ts`.
    const host = await residentHost();
    const record = await runThenLeave(host, { maxIterations: 3 });
    const tui = await laptop(host, { maxIterations: 5 }, record);
    const session = tui.runtime.createSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tui.notices).toEqual([]);
    for await (const _event of session.send("again")) {
      // drain
    }
    expect(tui.notices.join("\n")).toContain(DRIFT);
    await tui.runtime.release();
  });

  test("the daemon restarted: rebuilt with the laptop's values, so nothing is kept and nothing said", async () => {
    // Mutation: compare with anything but what this open created → a false "keeps".
    const record = await runThenLeave(await residentHost(), { maxIterations: 3 });
    const tui = await laptop(await residentHost(), { maxIterations: 5 }, record);
    expect(await tui.runtime.attachTo(UID, record)).toBe(false);
    await tui.runtime.openSeeded(record);
    expect(tui.notices).toEqual([]);
    await tui.runtime.release();
  });

  test("a plain attach that finds no live session stays lazy, seeded from the record", async () => {
    const record = await runThenLeave(await residentHost(), { maxIterations: 3 });
    const tui = await laptop(await residentHost(), { maxIterations: 5 }, record);
    expect(await tui.runtime.attachTo(UID, record)).toBe(false);
    const session = tui.runtime.createSession();
    for await (const _event of session.send("again")) {
      // drain
    }
    await session.flushed();
    await tui.saver.drain();
    const saved = await tui.store.load(UID);
    expect(saved.status === "ok" ? saved.record.messages.length : 0).toBe(
      record.messages.length + 2,
    );
    await tui.runtime.release();
  });
});
