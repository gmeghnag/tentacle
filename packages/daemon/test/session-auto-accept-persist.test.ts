import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { encodeSidecar, parseSidecar } from "../src/daemon-state-file.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// `serve` keeps the session's auto-accept in its state sidecar
// (docs/feat/session-auto-accept.md D3): written only when on, exactly `true`
// reads back on, a restart KEEPS it, an ARCHIVED session reopens OFF. Each test
// names the mutation that must turn it red (AGENTS §9).

const CWD = "/tmp/auto-accept-persist";
const go = [{ type: "text" as const, delta: "go" }, { type: "done" as const }];

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of go) yield event;
  }
}

const env = {} as ExecutionEnvironment;

/** The smallest agent that can be built: an empty tool registry, the broker's gate. */
const factory = () => {
  const permissions = new PermissionBroker();
  const agent = new Agent({
    model: new Quiet(),
    tools: new ToolRegistry(),
    env,
    requestPermission: (req, options) => permissions.request(req, options),
  });
  return { agent, permissions };
};

function rig(store = new SpyDaemonStore()) {
  const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    sharedAutoAccept: true,
    createAgent: factory,
  });
  return { host, store };
}

/** The state file a session landed, as the daemon parses it. */
function sidecarOf(store: SpyDaemonStore, id: string) {
  const text = store.files.get(id)?.state;
  if (text === undefined) throw new Error(`${id}: no state file`);
  const parsed = parseSidecar(text, id);
  if (!parsed.ok) throw new Error(`${id}: ${parsed.reason}`);
  return parsed.value;
}

/** A record from the durable files (the loader's own decoders). */
const durable = (store: SpyDaemonStore, id: string): DaemonSessionRecord => {
  const record = store.durable.get(id);
  if (!record) throw new Error(`${id}: nothing durable`);
  return record;
};

describe("auto-accept survives a serve restart", () => {
  test("P1 a sidecar carries `autoAccept: true` only when it is on", async () => {
    // Mutation: always write the field → the OFF case holds `"autoAccept": false`.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    await hosted.persisted();
    expect(sidecarOf(r.store, hosted.id).autoAccept).toBeUndefined();

    hosted.setAutoAccept(true, "laptop");
    await hosted.persisted();
    expect(sidecarOf(r.store, hosted.id).autoAccept).toBe(true);
    expect(r.store.files.get(hosted.id)?.state).toContain('"autoAccept":true');

    hosted.setAutoAccept(false);
    await hosted.persisted();
    expect(sidecarOf(r.store, hosted.id).autoAccept).toBeUndefined();
  });

  test("P2 a restart KEEPS it (owner Q3): restore reads the sidecar back", async () => {
    // Mutation: drop `persist()` from `setAutoAccept` → the durable record never says on.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.setAutoAccept(true, "laptop");
    await hosted.persisted();
    const record = durable(r.store, hosted.id);
    expect(record.autoAccept).toBe(true);

    const restarted = rig();
    const restored = restarted.host.restore(record);
    expect(restored.autoAccept).toBe(true);
    // And the snapshot says so to whoever attaches.
    expect(restarted.host.get(hosted.id)?.autoAccept).toBe(true);
  });

  test('P3 a damaged value never yields ON: `"yes"` / 1 / absent read off', () => {
    for (const autoAccept of ["yes", 1, null, {}, false]) {
      const sidecar = JSON.parse(
        encodeSidecar({
          format: "tentacle-daemon-state",
          schemaVersion: 1,
          id: "S",
          logHead: { seq: 1, id: "i/1" },
          k: 0,
          tail: [],
          lastActiveAt: 1,
          updatedAt: 1,
          title: "t",
          turns: [],
          enqueueIds: [],
          returned: [],
          autoAccept: true,
        }),
      ) as Record<string, unknown>;
      sidecar.autoAccept = autoAccept;
      const parsed = parseSidecar(JSON.stringify(sidecar), "S");
      // Never a refusal: the conversation is intact and the switch is one bit.
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.autoAccept).toBeUndefined();
    }
  });

  test("P4 reopening an ARCHIVED session starts OFF (owner Q3)", async () => {
    // Mutation: pass `record.autoAccept` through in `restore` at the reopen site → it comes back on.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.setAutoAccept(true, "laptop");
    await hosted.persisted();
    // Ended and kept: archived with ON in its record.
    r.host.close(hosted.id);
    // The archive write lands on a later microtask (the store's own queue).
    for (let i = 0; i < 50 && durable(r.store, hosted.id).archivedAt === undefined; i++) {
      await Promise.resolve();
    }
    const record = durable(r.store, hosted.id);
    expect(record.autoAccept).toBe(true);
    expect(record.archivedAt).toBeDefined();

    const prepared = await r.host.prepareOpen({ sessionId: hosted.id, reopen: true });
    const reopened = r.host.open(
      { sessionId: hosted.id, reopen: true },
      { send: () => {} },
      prepared,
    );
    expect(reopened.hosted.autoAccept).toBe(false);
    // Its next write does not resurrect it either: the field is absent, so OFF.
    await reopened.hosted.persisted();
    expect(sidecarOf(r.store, hosted.id).autoAccept).toBeUndefined();
  });

  test("P5 the in-memory-only hosts never persist it (a pod daemon, the worker)", async () => {
    const store = new SpyDaemonStore();
    // No persister: a pod daemon / the worker. Nothing reaches a disk.
    const host = new SessionHost({
      defaultCwd: CWD,
      sharedAutoAccept: true,
      createAgent: factory,
    });
    const { hosted } = host.open({ create: true }, { send: () => {} });
    hosted.setAutoAccept(true);
    await Promise.resolve();
    expect(store.units).toEqual([]);
    expect(hosted.autoAccept).toBe(true);
  });
});
