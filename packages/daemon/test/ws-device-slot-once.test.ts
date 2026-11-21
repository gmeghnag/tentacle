/**
 * The limiter slot of a `/e2e` socket is ended EXACTLY once, however the
 * handshake dies (docs/feat/mobile-relay.md R3). The extraction split the old
 * single `finish()` into two paths — the socket's `close` and the device path's
 * `onSettled` — and a phone that walks away mid-handshake fires BOTH, so without
 * a once-guard `HandshakeLimiter.end()` runs twice for one dial. The counter then
 * sits below the number of handshakes really in flight and admits more than
 * `maxConcurrent`.
 *
 * The proof has to interleave: an abandoned socket's second `end()` must steal
 * the slot of a LIVE one, and the count must then be seen from outside — the cap
 * refuses exactly one dial too late. Cap 2:
 *
 *   1. A dials, stays mid-handshake      (running 1)
 *   2. B dials, stays mid-handshake      (running 2)
 *   3. A closes mid-handshake            (correct: 1 — B's slot; double end: 0)
 *   4. C dials, stays mid-handshake      (correct: 2 — full; double end: 1)
 *   5. D dials                           (correct: REFUSED; double end: admitted)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyOf } from "@tentacle/transport/noise";
import { DeviceAuthority } from "../src/device-authority.ts";
import { addDevice, loadOrCreateIdentity } from "../src/device-store.ts";
import { SessionHost } from "../src/session-host.ts";
import { startWsServer } from "../src/ws-server.ts";

/** This serve's project (docs/feat/mobile-projects.md §2). */
const TEST_PROJECT = { key: "proj-0123456789ab", cwd: "/u/proj" };

const dirs: string[] = [];
const servers: { stop(): void }[] = [];
const authorities: DeviceAuthority[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const a of authorities.splice(0)) a.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const IOS_ORIGIN = "http://192.168.1.8:4001";

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "ws-slot-once-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  addDevice(configDir, {
    project: TEST_PROJECT,
    publicKey: publicKeyOf(key(2)),
    name: "iPhone",
    now: 2_000,
  });
  return configDir;
}

/** Dial `/e2e` and leave the handshake open (a phone that connected and stalled). */
function dialOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: IOS_ORIGIN } } as never);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("refused")));
    // Nothing is ever sent: the responder is waiting for message 1.
  });
}

/** Is a dial admitted? An upgraded socket opens; a 429 refuses it. */
function dialAdmitted(url: string): Promise<boolean> {
  return dialOpen(url).then(
    (ws) => {
      ws.close();
      return true;
    },
    () => false,
  );
}

describe("a mid-handshake close ends the limiter slot once, not twice (R3)", () => {
  test("an abandoned dial's extra `end()` cannot steal a live handshake's slot", async () => {
    const configDir = store();
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    authorities.push(authority);
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: dummyHost,
      devices: {
        authority,
        // Room for exactly two handshakes in flight.
        handshakeLimit: { burst: 100, refillMs: 60_000, maxConcurrent: 2 },
      },
    });
    servers.push(server);
    const url = `${server.url}/e2e`;
    // 1, 2: both admitted and held mid-handshake.
    const a = await dialOpen(url);
    const b = await dialOpen(url);
    // 3: A walks away mid-handshake.
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    // 4: C takes A's slot — the cap is full again (B and C live).
    const c = await dialOpen(url);
    // 5: D must be refused. Under a double `end()`, A's second decrement stole
    // B's slot at step 3 and D is wrongly admitted here.
    expect(await dialAdmitted(url)).toBe(false);
    b.close();
    c.close();
    await new Promise((r) => setTimeout(r, 50));
    // Once both really are gone, the cap is free again: nothing leaked either way.
    expect(await dialAdmitted(url)).toBe(true);
  });
});
