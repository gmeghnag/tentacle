/**
 * THE load-bearing test (docs/feat/mobile-pairing-screen.md 11b.1, Tests
 * "pairing-e2e.test.ts"): REAL loopback sockets, a real daemon, a real
 * `pairCommand` with an injected `ask`, and the app's own `runPairing` +
 * `openComputer`, dialling through `rnWebSocketCtor` around a Bun `WebSocket`
 * that sends an iOS-style `Origin` — the phone's whole path, minus Hermes (Step
 * 0 proved that on the simulator).
 *
 * What only this file can prove:
 * - the phone pairs with a code, and BOTH ends show the same 6-digit code;
 * - the stored record's id is the pinned key's id (P3), and the device key
 *   reaches the store (so a later dial is possible at all);
 * - after pairing, `openComputer` → `sessionList` works over `/e2e` as a DEVICE
 *   (a plain token route is not involved, and iOS's `Origin` is not rejected);
 * - `n` declines and stores nothing; an elapsed window reaches the app as
 *   `expired`; Cancel closes the socket the server sees;
 * - a revoke while linked → the link stops and the diagnosis says `revoked`
 *   (from the ERROR OBJECT, never the link's `stopped.reason` prose);
 * - the RECOVERY path of that revoke: "Pair again" through the app's own link
 *   registry and diagnosis map dials the NEW device key and works again
 *   (fix round 1 finding 1);
 * - a `devices reset` → three redials → `maybe-reset`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { ChannelError } from "@tentacle/client";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import {
  DeviceAuthority,
  SessionHost,
  deviceIdOf,
  loadOrCreateIdentity,
  readIdentity,
  startWsServer,
} from "@tentacle/daemon";
import type { PairingPayload } from "@tentacle/protocol";
import { parsePairingPayload } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { systemRandom } from "@tentacle/transport/noise";
import {
  type DeviceCommands,
  type PairCommandOptions,
  loadDeviceCommands,
  loadPairCommand,
} from "../e2e/pair-cli.ts";
import { withForgottenRecord } from "../src/computer-memory.ts";
import { type ComputerStore, type SecureKV, createComputerStore } from "../src/computer-store.ts";
import { openComputer } from "../src/connection.ts";
import { createLinkDiagnoser, diagnosisMessage } from "../src/link-diagnosis.ts";
import { createLinkRegistry } from "../src/link-registry.ts";
import { type PairingState, pairingView, reduce, runPairing } from "../src/pairing-flow.ts";
import type { RNWebSocketCtor } from "../src/rn-websocket.ts";
import { rnWebSocketCtor } from "../src/rn-websocket.ts";

const IOS_ORIGIN = "http://192.168.1.8:4001";
const dirs: string[] = [];
const servers: { stop(): void }[] = [];
const authorities: DeviceAuthority[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  for (const a of authorities.splice(0)) {
    a.stop();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await sleep(10);
  }
}

const CWD = tmpdir();

/** Enough model to finish a turn (the connection test's own `Echo`). */
class Echo implements ModelProvider {
  readonly id = "echo";
  async *stream(): AsyncIterable<{ type: "text"; delta: string } | { type: "done" }> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const dummyHost = new SessionHost({
  defaultCwd: CWD,
  createAgent: () => ({
    agent: new Agent({ model: new Echo(), tools: new ToolRegistry(), env: env as never }),
    permissions: new PermissionBroker(),
  }),
});

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mobile-pairing-e2e-"));
  dirs.push(dir);
  return dir;
}

/**
 * A config dir whose computer identity ALREADY exists — what a real `serve`
 * finds on the user's host (the daemon's `/e2e` route refuses to authenticate
 * anything without one: `ws-server.ts` closes the socket as `e2e-no-identity`).
 * `pairCommand` creates the identity when it is missing, but it would be too
 * late here: the authority snapshot it reads is taken when the server starts.
 */
function computerConfigDir(): string {
  const dir = configDir();
  const created = loadOrCreateIdentity(dir, {
    name: "gmeghnag-mac",
    now: 1_000,
    random: () => new Uint8Array(32).fill(9),
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return dir;
}

/** A real daemon with the `/e2e` device route, as `serve` mounts it (P7). */
function serve(dir: string): { url: string } {
  const authority = new DeviceAuthority({ configDir: dir, pollIntervalMs: 10 });
  authorities.push(authority);
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: dummyHost,
    devices: { authority, pairingCheckMs: 20 },
    token: "e2e-token",
  });
  servers.push(server);
  return { url: `${server.url}/e2e` };
}

/**
 * RN's WebSocket, as the phone has it: Bun's under a `(url, protocols, options)`
 * constructor, with `rnWebSocketCtor`'s adapter in the middle — AND an iOS-style
 * `Origin` header on every dial, which is the whole point of the `/e2e` route.
 */
const PhoneWebSocket: RNWebSocketCtor = class {
  readonly #ws: WebSocket;
  constructor(url: string, protocols?: string | string[], options?: unknown) {
    const { headers } = (options ?? {}) as { headers?: Record<string, string> };
    this.#ws = new WebSocket(url, {
      protocols,
      headers: { Origin: IOS_ORIGIN, ...headers },
    } as never);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#ws.addEventListener(type, listener as never);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#ws.removeEventListener(type, listener as never);
  }
  send(data: string): void {
    this.#ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }
} as unknown as RNWebSocketCtor;

/** The app's WebSocket constructor: RN's shape, wrapped exactly as `openComputer` expects. */
const Ctor = rnWebSocketCtor(PhoneWebSocket);
const factoryDeps = { WebSocket: Ctor };

/**
 * The phone's dial to one address (what `App.tsx` injects): the client's own
 * factory, no token, over RN's WebSocket — through `rnWebSocketCtor`, so the
 * iOS-style `Origin` on `PhoneWebSocket` is what the daemon sees.
 */
const phoneDial = (address: string) => () => webSocketChannelFactory(address, {}, factoryDeps)();

function memoryKV(): { kv: SecureKV; items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    kv: {
      async get(key) {
        return items.get(key) ?? null;
      },
      async set(key, value) {
        items.set(key, value);
      },
      async delete(key) {
        items.delete(key);
      },
    },
  };
}

/**
 * `tentacle pair`, in-process (P6: no TTY, so the harness injects `ask`).
 * Returns the payload text as soon as `pair` printed it, and the hooks a flow
 * uses: `waitForAsk` (the human's prompt) and `answer`.
 */
async function startPair(options: {
  readonly dir: string;
  readonly address: string;
  readonly ttlMs?: number;
}): Promise<{
  readonly payload: PairingPayload;
  /** The pasteable line `pair` printed (what a person copies into the app). */
  readonly text: string;
  readonly prompt: () => string | undefined;
  readonly answer: (value: "y" | "n") => void;
  readonly done: Promise<number>;
}> {
  let payloadLine = "";
  let prompt: string | undefined;
  let answer: "y" | "n" = "y";
  const pairCommand = await loadPairCommand();
  const done = pairCommand({
    configDir: options.dir,
    extraAddresses: [options.address],
    interfaces: [],
    qr: false,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    pollMs: 10,
    out: (line) => {
      payloadLine = line.trim();
    },
    err: () => {},
    ask: async (text) => {
      prompt = text;
      return answer;
    },
  });
  await until(() => payloadLine !== "");
  const parsed = parsePairingPayload(payloadLine);
  if (!parsed.ok) {
    throw new Error(`pair printed an unparseable payload: ${parsed.reason}`);
  }
  return {
    payload: parsed.payload,
    text: payloadLine,
    prompt: () => prompt,
    answer: (value) => {
      answer = value;
    },
    done,
  };
}

/** The digits the terminal showed, out of `Add 'x'? It must show 123 456. [y/N]`. */
function sasOf(prompt: string): string {
  const match = /(\d{3}) (\d{3})/.exec(prompt);
  return match === null ? "" : `${match[1]}${match[2]}`;
}

/** Drive the reducer from intake to review and return the review state. */
function reviewed(text: string): PairingState {
  const intake = reduce({ name: "intake", text }, { type: "text", text });
  return reduce(intake, { type: "submit" });
}

/** Run the pairing the person confirmed, collecting every action the screen would see. */
async function pairThroughFlow(options: {
  readonly state: PairingState;
  readonly store: Pick<ComputerStore, "add">;
  readonly dispatch?: (action: unknown) => void;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: boolean; readonly state: PairingState }> {
  if (options.state.name !== "review") {
    throw new Error(`not at review: ${options.state.name}`);
  }
  const payload = options.state.payload;
  const deviceName = options.state.deviceName;
  let state: PairingState = reduce(options.state, { type: "confirm" });
  const outcome = await runPairing({
    payload,
    deviceName,
    store: options.store,
    dial: phoneDial,
    random: systemRandom,
    signal: options.signal,
    dispatch: (action) => {
      state = reduce(state, action);
      options.dispatch?.(action);
    },
  });
  return { ok: outcome.ok, state };
}

describe("pairing over /e2e, as the phone does it", () => {
  test("happy path: both ends show one code; the record is the pinned key's id; then session/list works", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url });
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    let phoneSas = "";
    const { ok, state: after } = await pairThroughFlow({
      state,
      store,
      dispatch: (action) => {
        const typed = action as { readonly type: string; readonly sas?: string };
        if (typed.type === "compare") {
          phoneSas = typed.sas ?? "";
        }
      },
    });
    expect(ok).toBe(true);
    expect(after.name).toBe("done");
    expect(pairing.done).toBeDefined();
    expect(await pairing.done).toBe(0);
    // BOTH ends showed the same 6 digits: the phone's SAS is the terminal's.
    const prompt = pairing.prompt() ?? "";
    expect(sasOf(prompt)).not.toBe("");
    expect(phoneSas).toBe(sasOf(prompt));
    // P3: the stored id is the id of the key we pinned.
    const identity = readIdentity(dir);
    if (!identity.ok) {
      throw new Error(identity.reason);
    }
    const entries = memory.items.get("tentacle.computers");
    expect(entries).toBeDefined();
    const stored = JSON.parse(
      memory.items.get(`tentacle.computer.${deviceIdOf(identity.identity.publicKey)}`) ?? "null",
    ) as {
      readonly id?: string;
      readonly computerKey?: string;
      readonly deviceKey?: string;
    } | null;
    expect(stored?.id).toBe(deviceIdOf(identity.identity.publicKey));
    expect(stored?.deviceKey).toBeDefined();
    // The record lists in the app's source, and it is NOT broken.
    expect((await store.list()).map((entry) => entry.state)).toEqual(["paired"]);

    // The phone's link over `/e2e`, as a DEVICE: `session/list` answers.
    const computer = await store.get(deviceIdOf(identity.identity.publicKey));
    if (computer === undefined) {
      throw new Error("stored computer missing");
    }
    // A session created by a TOKEN client (the harness's own laptop client), on
    // the plain route: the phone must see it through `/e2e`.
    const laptop = new RemoteClient(
      await webSocketChannelFactory(`ws://${new URL(url).host}/`, { token: "e2e-token" })(),
      new PermissionBroker(undefined, { holdUntilSet: true }),
      undefined,
      {
        channelFactory: webSocketChannelFactory(`ws://${new URL(url).host}/`, {
          token: "e2e-token",
        }),
      },
    );
    await laptop.initialize();
    const sessionId = crypto.randomUUID();
    const session = laptop.newSession(undefined, sessionId);
    // One finished turn: the send is what creates AND opens the session.
    for await (const _event of session.send("hi")) {
      // drain the turn: `send` is what creates AND opens the session
    }

    const link = await openComputer(computer, { WebSocket: PhoneWebSocket, random: systemRandom });
    const page = await link.client.sessionList({ limit: 5 });
    // The phone sees the LAPTOP's session: a paired device has a token client's
    // rights (decision 5), over an authenticated `/e2e` channel.
    expect(page.sessions.map((entry) => entry.sessionId)).toContain(sessionId);
    expect(link.init.protocolVersion).toBeGreaterThan(0);
    expect(link.diagnosis.current()).toBe("ok");
    await link.close();
    // Teardown: DETACH the laptop (never `closeSessions`), so the scratch daemon
    // has nothing left attached.
    await laptop.drain().catch(() => {});
    laptop.close();
  }, 30_000);

  test("paired, but the Keychain write fails → `store`, and `done` is NEVER dispatched (F-P12; mutation: dispatch `done` first → red)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url });
    const state = reviewed(pairing.text);
    // The computer DOES accept (a real `y`): only the phone's write fails.
    if (state.name !== "review") {
      throw new Error("not at review");
    }
    const actions: string[] = [];
    let current: PairingState = reduce(state, { type: "confirm" });
    const outcome = await runPairing({
      payload: state.payload,
      deviceName: state.deviceName,
      // A Keychain that refuses every write (a locked device, an OS error).
      store: {
        async add() {
          throw new Error("keychain write failed");
        },
      },
      dial: phoneDial,
      random: systemRandom,
      dispatch: (action) => {
        actions.push(action.type);
        current = reduce(current, action);
      },
    });
    expect(outcome.ok).toBe(false);
    // The property: the record's write is what makes a pairing SUCCESSFUL, so
    // `done` must never have been dispatched — a `done` the store did not back
    // would show a computer that cannot be dialled (`openComputer` has no key).
    expect(actions).not.toContain("done");
    expect(actions).toEqual(["compare", "failed"]);
    expect(current.name).toBe("failed");
    expect(pairingView(current).failure?.reason).toBe("store");
    // The stale entry the copy names is on the computer (a `y` DID pair it).
    expect(await pairing.done).toBe(0);
  }, 30_000);

  test("the human answers n: the phone is told the code is gone, and NOTHING is stored", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    // DRIFT (docs/feat/mobile-pairing-screen.md Execution): `pairCommand` DELETES
    // the window's files as it exits, so the daemon's poll almost never sees the
    // `declined` decision it wrote — it finds the claim gone and answers
    // `timeout`. Both reach the same card; the reason is the honest one.
    const pairing = await startPair({ dir, address: url, ttlMs: 1_500 });
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    // `ask` runs only when the claim arrives, so the answer is set UP FRONT:
    // waiting for the prompt first would deadlock (the claim IS our dial).
    pairing.answer("n");
    const { ok, state: after } = await pairThroughFlow({ state, store });
    expect(ok).toBe(false);
    expect(after.name).toBe("failed");
    // Never `ok`, never stored; and the sentence names the code, not a network fault.
    const reason = pairingView(after).failure?.reason;
    expect(reason === "declined" || reason === "timeout").toBe(true);
    expect(memory.items.size).toBe(0);
    expect(await pairing.done).toBe(1);
  }, 30_000);

  test("a window that expired before the dial is `expired` (a denied handshake, P4)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url, ttlMs: 1 });
    // `pair` closes its own window when the TTL elapses (before the phone dials).
    await sleep(60);
    await until(() => false, 50);
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    const { ok, state: after } = await pairThroughFlow({ state, store });
    expect(ok).toBe(false);
    expect(pairingView(after).failure?.reason).toBe("expired");
    expect(memory.items.size).toBe(0);
  }, 30_000);

  test("Cancel during compare closes the pairing socket the server sees (mutation: UI-only cancel → red)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url, ttlMs: 1_500 });
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    const controller = new AbortController();
    let compared = 0;
    const running = pairThroughFlow({
      state,
      store,
      signal: controller.signal,
      dispatch: (action) => {
        if ((action as { readonly type: string }).type === "compare") {
          compared += 1;
          // The person changes their mind the instant the code appears: the
          // claim (`device/pair`) has not been sent yet.
          controller.abort();
        }
      },
    });
    const { ok, state: after } = await running;
    expect(compared).toBe(1);
    expect(ok).toBe(false);
    // F-P9: the computer may still be asking, so the copy says so.
    expect(pairingView(after).failure?.mayStillPrompt).toBe(true);
    // The server saw the pairing socket CLOSE (the claim never became a device).
    // `pair` never even reached its `[y/N]`: there was no claim to ask about.
    expect(pairing.prompt()).toBeUndefined();
    expect(memory.items.size).toBe(0);
    // The window expires on its own (no claim ⇒ no ask ⇒ nobody to answer), and
    // the phone's cancel left no device behind.
    expect(await pairing.done).toBe(1);
  }, 30_000);

  test("a revoke while linked → the link stops and the diagnosis says `revoked` (mutation: read `stopped.reason` text → red)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url });
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    const { ok } = await pairThroughFlow({ state, store });
    expect(ok).toBe(true);
    await pairing.done;
    const identity = readIdentity(dir);
    if (!identity.ok) {
      throw new Error(identity.reason);
    }
    const computer = await store.get(deviceIdOf(identity.identity.publicKey));
    if (computer === undefined) {
      throw new Error("stored computer missing");
    }
    // The diagnoser is the LINK's (mounted as the screen does).
    const link = await openComputer(computer, { WebSocket: PhoneWebSocket, random: systemRandom });
    const statuses: string[] = [];
    link.onStatus((status) => statuses.push(status.state));
    await link.client.sessionList({ limit: 1 });
    expect(link.diagnosis.current()).toBe("ok");
    // The laptop revokes this phone: the daemon closes the live socket.
    const { revokeCommand } = await loadDeviceCommands();
    const code = revokeCommand("iPhone", {
      configDir: dir,
      out: () => {},
      err: () => {},
      now: () => Date.now(),
    });
    expect(code).toBe(0);
    // The link's own redial is denied at the handshake (an authenticated verdict).
    await until(() => statuses.includes("stopped"), 10_000);
    expect(statuses).toContain("stopped");
    // F-L1: the diagnosis is read from the ERROR OBJECT, not from the stopped
    // reason's prose (`link-machine.ts` writes "the daemon rejected the
    // credentials: …", which says nothing about a revoke).
    await until(() => link.diagnosis.current() === "revoked", 10_000);
    expect(link.diagnosis.current()).toBe("revoked");
    await link.close();
  }, 40_000);

  test("a `devices reset` → three redials → `maybe-reset` (F-L3)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const pairing = await startPair({ dir, address: url });
    const state = reviewed(pairing.text);
    const memory = memoryKV();
    const store = createComputerStore({ kv: memory.kv, keychainAccessible: 1 });
    const { ok } = await pairThroughFlow({ state, store });
    expect(ok).toBe(true);
    await pairing.done;
    const identity = readIdentity(dir);
    if (!identity.ok) {
      throw new Error(identity.reason);
    }
    const computer = await store.get(deviceIdOf(identity.identity.publicKey));
    if (computer === undefined) {
      throw new Error("stored computer missing");
    }
    // The computer gets a NEW identity: our pinned key is simply wrong now, so
    // the handshake fails `closed` (not `denied` — the new key cannot deny us,
    // it never knew us).
    const { resetCommand } = await loadDeviceCommands();
    const resetCode = await resetCommand({
      configDir: dir,
      out: () => {},
      err: () => {},
      now: () => Date.now(),
      yes: true,
      name: "gmeghnag-mac",
    });
    expect(resetCode).toBe(0);
    // Let the daemon NOTICE the new identity (its store stamp poll), else the
    // next dial is answered with the OLD key — a deny our pinned key still
    // decrypts, i.e. `unauthorized`, which is a different fact (a revoke).
    await sleep(250);
    // ONE diagnoser per computer, carried across mounts (the seam `openComputer`
    // takes): a reset can only be inferred from successive FAILED attempts, and
    // each `openComputer` here throws (there is no link to hold it).
    const diagnosis = createLinkDiagnoser();
    const verdicts: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const caught = await openComputer(computer, {
        WebSocket: PhoneWebSocket,
        random: systemRandom,
        diagnosis,
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ChannelError);
      expect((caught as ChannelError).kind).toBe("unreachable");
      verdicts.push(diagnosis.current());
    }
    // Two attempts must NOT claim a reset (the mutation this pins: count every
    // failure and it would say so at the first); the third may.
    expect(verdicts).toEqual(["unreachable", "unreachable", "maybe-reset"]);
    expect(diagnosisMessage(diagnosis.current(), computer.name)).toContain("reset");
  }, 40_000);

  test("REVOKE → 'Pair again' recovers on the app's own registry (mutation: drop `withForgottenRecord` → red)", async () => {
    const dir = computerConfigDir();
    const { url } = serve(dir);
    const store = createComputerStore({ kv: memoryKV().kv, keychainAccessible: 1 });
    /** One whole pairing through the reducer + runner, as the screen drives it. */
    const pair = async (): Promise<void> => {
      const pairing = await startPair({ dir, address: url });
      const via = await pairThroughFlow({ state: reviewed(pairing.text), store });
      expect(via.ok).toBe(true);
      await pairing.done;
    };
    await pair();
    const identity = readIdentity(dir);
    if (!identity.ok) {
      throw new Error(identity.reason);
    }
    const id = deviceIdOf(identity.identity.publicKey);
    const computer = await store.get(id);
    if (computer === undefined) {
      throw new Error("stored computer missing");
    }
    // The app's OWN wiring, minus React (`App.tsx` cannot be imported: RN is Flow).
    const records = new Map([[id, computer]]);
    const diagnoses = new Map<string, ReturnType<typeof createLinkDiagnoser>>();
    const diagnoserFor = (key: string): ReturnType<typeof createLinkDiagnoser> => {
      const known = diagnoses.get(key);
      if (known !== undefined) {
        return known;
      }
      const created = createLinkDiagnoser();
      diagnoses.set(key, created);
      return created;
    };
    const closed: string[] = [];
    const links = createLinkRegistry<{ readonly client: RemoteClient; close(): Promise<void> }>({
      // `LINKS.open` re-reads the record every dial, so a re-pair's new device
      // key is what the NEXT dial would use — if a next dial ever came.
      open: async (key) => {
        const record = await store.get(key);
        if (record === undefined) {
          throw new Error(`unknown computer ${key}`);
        }
        records.set(key, record);
        const link = await openComputer(record, {
          WebSocket: PhoneWebSocket,
          random: systemRandom,
          diagnosis: diagnoserFor(key),
        });
        return {
          client: link.client,
          close: async () => {
            closed.push(record.deviceKey);
            await link.close();
          },
        };
      },
      close: (link) => link.close(),
    });
    const memory = { links, diagnoses, records };
    /** What `loadRows()` does for one computer: dial, read, report its verdict. */
    const row = async (): Promise<string> => {
      const link = await links.get(id);
      await link.client.sessionList({ limit: 1 });
      return diagnoserFor(id).current();
    };

    // 1. Linked and healthy.
    expect(await row()).toBe("ok");
    // 2. `tentacle devices revoke`: the live link's redial is denied, and its
    //    own diagnoser reads that as `revoked` (the ERROR OBJECT, F-L1).
    const { revokeCommand } = await loadDeviceCommands();
    expect(
      revokeCommand("iPhone", {
        configDir: dir,
        out: () => {},
        err: () => {},
        now: () => Date.now(),
      }),
    ).toBe(0);
    await until(() => diagnoserFor(id).current() === "revoked", 20_000);
    expect(diagnoserFor(id).current()).toBe("revoked");

    // 3. "Pair again" (Owner Q7's recovery): a FRESH device key, the SAME id.
    await pair();
    // 4. `onDone` → forget → reload, which re-dials the computer.
    await withForgottenRecord(memory, id, async () => {
      // The recovered computer works, and says nothing (no stale `revoked`).
      expect(await row()).toBe("ok");
    });
    // The old link really was closed (a detach, never leaked) …
    expect(closed).toEqual([computer.deviceKey]);
    // … it was the OLD device key's link …
    const replaced = await store.get(id);
    expect(replaced?.deviceKey).not.toBe(computer.deviceKey);
    // … and the read really used the NEW key: the daemon accepted this device.
    const reread = records.get(id);
    if (replaced === undefined || reread === undefined) {
      throw new Error("the store lost the re-paired computer");
    }
    expect(reread.deviceKey).toBe(replaced.deviceKey);
    await links.closeAll();
  }, 60_000);
});
