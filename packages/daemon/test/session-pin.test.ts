import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  MAX_PINNED_SESSIONS,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { encodeSidecar, parseSidecar } from "../src/daemon-state-file.ts";
import type { Attachment } from "../src/hosted-session.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// `session/pin` (docs/feat/mobile-session-actions.md S1): a pin lives in the
// `serve` daemon's state sidecar (never the log), on live AND archived
// sessions, moves no `updatedAt`, and is surfaced by `session/list`. Each
// test names the mutation that must turn it red (AGENTS §9).

const CWD = "/tmp/session-pin";
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const factory = () => ({
  agent: new Agent({
    model: new Quiet(),
    tools: new ToolRegistry(),
    env: {} as ExecutionEnvironment,
  }),
  permissions: new PermissionBroker(),
});

function rig(store: SpyDaemonStore | null = new SpyDaemonStore()) {
  const errors: Error[] = [];
  const persister = store
    ? new SessionPersister({ store, cwd: CWD, model: "m", onError: (e) => errors.push(e) })
    : undefined;
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(persister ? { persister } : {}),
    createAgent: factory,
  });
  return { host, store, persister, errors };
}

const attachment: Attachment = { send: () => {} };

async function exchanged(host: SessionHost, id = "s1") {
  const { hosted } = host.open({ sessionId: id, create: true }, attachment);
  hosted.prompt("t1", [{ type: "text", text: `hello ${id}` }]);
  await until(() => !hosted.running);
  return hosted;
}

/** The state file a session landed, as the daemon parses it. */
function sidecar(store: SpyDaemonStore, id: string) {
  const text = store.files.get(id)?.state;
  if (text === undefined) throw new Error(`${id}: no state file`);
  const parsed = parseSidecar(text, id);
  if (!parsed.ok) throw new Error(`${id}: ${parsed.reason}`);
  return parsed.value;
}

const durable = (store: SpyDaemonStore, id: string): DaemonSessionRecord => {
  const record = store.durable.get(id);
  if (!record) throw new Error(`${id}: nothing durable`);
  return record;
};

const entry = (host: SessionHost, id: string) =>
  host.list({}).sessions.find((s) => s.sessionId === id);

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return error instanceof RpcError ? error.code : error;
  }
};

/** Archive `id` and wait until its archive write landed (no longer resident). */
async function archived(r: ReturnType<typeof rig>, id = "s1") {
  r.host.close(id);
  await until(() => r.store?.durable.get(id)?.archivedAt !== undefined);
  await tick(5);
}

describe("pin a live session", () => {
  test("listed pinned, updatedAt unchanged, written to the sidecar; unpin clears both", async () => {
    // Mutation: `setPinned` without `this.persist()` → the sidecar never carries it.
    const r = rig();
    await exchanged(r.host);
    const store = r.store as SpyDaemonStore;
    const before = entry(r.host, "s1");
    expect(before?.pinned).toBeUndefined();
    expect(r.host.pin("s1", true)).toEqual({ pinned: true });
    const after = entry(r.host, "s1");
    expect(after?.pinned).toBe(true);
    expect(after?.updatedAt).toBe(before?.updatedAt as number);
    await until(() => store.files.get("s1")?.state?.includes('"pinnedAt"') === true);
    expect(sidecar(store, "s1").pinnedAt).toBeNumber();
    // The log is untouched by a pin: no new entry type, critical or not.
    expect(store.files.get("s1")?.log ?? "").not.toMatch(/pinned/i);
    expect(r.host.pin("s1", false)).toEqual({ pinned: false });
    expect(entry(r.host, "s1")?.pinned).toBeUndefined();
    await until(() => store.files.get("s1")?.state?.includes('"pinnedAt"') === false);
    expect(sidecar(store, "s1").pinnedAt).toBeUndefined();
  });

  test("a set, not a toggle: re-pinning keeps the first stamp and writes nothing", async () => {
    // Mutation: always restamp on pin → `pinnedAt` moves.
    const r = rig();
    await exchanged(r.host);
    const store = r.store as SpyDaemonStore;
    r.host.pin("s1", true);
    await until(() => store.files.get("s1")?.state?.includes('"pinnedAt"') === true);
    const stamp = sidecar(store, "s1").pinnedAt;
    const writes = store.stateWrites.length;
    const units = store.units.length;
    await tick(3);
    expect(r.host.pin("s1", true)).toEqual({ pinned: true });
    await tick(5);
    expect(store.stateWrites.length).toBe(writes);
    expect(store.units.length).toBe(units);
    expect(sidecar(store, "s1").pinnedAt).toBe(stamp as number);
  });

  test("a restart keeps the pin (decoded from the files by the real decoders)", async () => {
    // Mutation: drop `pinnedAt` from `sidecarOf` → the restarted session is not pinned.
    const r = rig();
    await exchanged(r.host);
    const store = r.store as SpyDaemonStore;
    r.host.pin("s1", true);
    await until(() => durable(store, "s1").pinnedAt !== undefined);
    const next = rig(new SpyDaemonStore());
    next.host.restore(durable(store, "s1"));
    expect(entry(next.host, "s1")?.pinned).toBe(true);
  });

  test("without a persister (pod daemon, in-process worker) a pin lives in memory", async () => {
    const r = rig(null);
    await exchanged(r.host);
    expect(r.host.pin("s1", true)).toEqual({ pinned: true });
    expect(entry(r.host, "s1")?.pinned).toBe(true);
  });
});

describe("pin an archived session", () => {
  test("in place: listed, only the state file rewritten (log untouched), not reopened", async () => {
    // Mutation: drop `pinChanged` from `rewriteArchived`'s guard → nothing is written.
    const r = rig();
    await exchanged(r.host);
    await archived(r);
    const store = r.store as SpyDaemonStore;
    const loads = store.loads.length;
    const units = store.units.length;
    const updatedAt = entry(r.host, "s1")?.updatedAt;
    expect(r.host.pin("s1", true)).toEqual({ pinned: true });
    expect(entry(r.host, "s1")).toMatchObject({ archived: true, pinned: true, updatedAt });
    await until(() => sidecar(store, "s1").pinnedAt !== undefined);
    expect(sidecar(store, "s1").archivedAt).toBeNumber();
    expect(r.host.get("s1")).toBeUndefined();
    expect(store.loads.length).toBe(loads);
    expect(store.units.length).toBe(units);
    r.host.pin("s1", false);
    expect(entry(r.host, "s1")?.pinned).toBeUndefined();
    await until(() => sidecar(store, "s1").pinnedAt === undefined);
  });

  test("a resident archived record (its write not landed yet) is rewritten with the pin", async () => {
    // Mutation: the resident path of `rewriteArchived` ignores the pin.
    const r = rig();
    await exchanged(r.host);
    const store = r.store as SpyDaemonStore;
    r.host.close("s1");
    r.host.pin("s1", true); // same tick: the archive write is still in flight
    await until(() => durable(store, "s1").pinnedAt !== undefined);
    expect(durable(store, "s1").archivedAt).toBeNumber();
  });

  test("archiving a pinned session keeps the pin; a reopen keeps it", async () => {
    // Mutation: drop `pinnedAt` from `persistedState` → the archive loses it.
    const r = rig();
    await exchanged(r.host);
    const store = r.store as SpyDaemonStore;
    r.host.pin("s1", true);
    await archived(r);
    expect(entry(r.host, "s1")).toMatchObject({ archived: true, pinned: true });
    expect(sidecar(store, "s1").pinnedAt).toBeNumber();
    const prepared = await r.host.prepareOpen({ sessionId: "s1", reopen: true });
    r.host.open({ sessionId: "s1", reopen: true }, attachment, prepared);
    expect(entry(r.host, "s1")).toMatchObject({ archived: false, pinned: true });
  });

  test("a reopen carries an archived pin made after the record was read", async () => {
    // Mutation: the reopen site restores the record's own pin, not the entry's.
    const r = rig();
    await exchanged(r.host);
    await archived(r);
    const prepared = await r.host.prepareOpen({ sessionId: "s1", reopen: true });
    r.host.pin("s1", true);
    r.host.open({ sessionId: "s1", reopen: true }, attachment, prepared);
    expect(entry(r.host, "s1")).toMatchObject({ archived: false, pinned: true });
  });

  test("a restart indexes an archived pin from the state file", async () => {
    // Mutation: drop `pinnedAt` from `loadState`'s meta → indexed unpinned.
    const r = rig();
    await exchanged(r.host);
    await archived(r);
    const store = r.store as SpyDaemonStore;
    r.host.pin("s1", true);
    await until(() => sidecar(store, "s1").pinnedAt !== undefined);
    const next = rig(store);
    const loaded = await next.persister?.loadState("s1");
    if (!loaded?.ok) throw new Error("no state");
    next.host.addArchived(loaded.meta);
    expect(entry(next.host, "s1")).toMatchObject({ archived: true, pinned: true });
  });
});

describe("errors and the cap", () => {
  test("a deleted id → SessionDeleted; an unknown one → UnknownSession", async () => {
    const r = rig();
    await exchanged(r.host);
    r.host.delete("s1");
    expect(codeOf(() => r.host.pin("s1", true))).toBe(DomainErrorCode.SessionDeleted);
    expect(codeOf(() => r.host.pin("nope", true))).toBe(DomainErrorCode.UnknownSession);
  });

  test(`at most ${MAX_PINNED_SESSIONS}, live + archived counted together; re-pin and unpin always pass`, async () => {
    // Mutation: count only live sessions → the archived pin is not counted and the 21st passes.
    expect(MAX_PINNED_SESSIONS).toBe(20);
    const r = rig();
    await exchanged(r.host, "a0");
    r.host.pin("a0", true);
    await archived(r, "a0");
    for (let i = 1; i < MAX_PINNED_SESSIONS; i++) {
      r.host.open({ sessionId: `s${i}`, create: true }, attachment);
      r.host.pin(`s${i}`, true);
    }
    r.host.open({ sessionId: "extra", create: true }, attachment);
    let message = "";
    try {
      r.host.pin("extra", true);
    } catch (error) {
      expect(error instanceof RpcError ? error.code : error).toBe(JsonRpcErrorCode.InvalidParams);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("unpin one first");
    expect(entry(r.host, "extra")?.pinned).toBeUndefined();
    // Re-pinning one already pinned at the cap is a no-op success, never a cap error.
    expect(r.host.pin("a0", true)).toEqual({ pinned: true });
    expect(r.host.pin("s1", true)).toEqual({ pinned: true });
    // Unpin one: the next pin passes.
    expect(r.host.pin("a0", false)).toEqual({ pinned: false });
    expect(r.host.pin("extra", true)).toEqual({ pinned: true });
  });
});

describe("sidecar", () => {
  const base = {
    format: "tentacle-daemon-state" as const,
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
  };

  test("round-trips pinnedAt; absent stays absent", () => {
    const pinned = parseSidecar(encodeSidecar({ ...base, pinnedAt: 42 }), "S");
    expect(pinned.ok && pinned.value.pinnedAt).toBe(42);
    const plain = parseSidecar(encodeSidecar(base), "S");
    expect(plain.ok).toBe(true);
    if (plain.ok) expect("pinnedAt" in plain.value).toBe(false);
    expect(encodeSidecar(base)).not.toContain("pinnedAt");
  });

  test("a malformed pinnedAt loads with no pin, never a refusal", () => {
    // Mutation: refuse a malformed value → `ok: false` (the conversation would be lost over one bit).
    for (const pinnedAt of ["x", -1, 1.5, null, {}, true]) {
      const raw = { ...base, pinnedAt } as Record<string, unknown>;
      const parsed = parseSidecar(JSON.stringify(raw), "S");
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.pinnedAt).toBeUndefined();
    }
  });
});

describe("session/pin over the wire", () => {
  test("UnknownSession, InvalidParams, a set, SessionDeleted; the first list page carries `pinned`", async () => {
    // Mutation: drop `case Method.Pin` in `Connection` → MethodNotFound.
    const r = rig();
    const [a, b] = createChannelPair();
    new Connection(b, r.host);
    const peer = new RpcPeer(a, { onNotification: () => {} });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof RpcError ? e.code : String(e)),
      );
    expect(await code(peer.request("session/pin", { sessionId: "nope", pinned: true }))).toBe(
      DomainErrorCode.UnknownSession,
    );
    await exchanged(r.host);
    expect(await code(peer.request("session/pin", { sessionId: "s1" }))).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    // Needs no prior open on this connection.
    expect(await peer.request("session/pin", { sessionId: "s1", pinned: true })).toEqual({
      pinned: true,
    });
    const first = (await peer.request("session/list", {})) as {
      sessions: { sessionId: string; pinned?: true }[];
      pinned?: { sessionId: string }[];
    };
    expect(first.sessions[0]).toMatchObject({ sessionId: "s1", pinned: true });
    expect(first.pinned?.map((s) => s.sessionId)).toEqual(["s1"]);
    r.host.delete("s1");
    expect(await code(peer.request("session/pin", { sessionId: "s1", pinned: false }))).toBe(
      DomainErrorCode.SessionDeleted,
    );
    peer.close();
  });
});
