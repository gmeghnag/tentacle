/**
 * A stopped project's RELAY address is `absent`, never `maybe-reset`
 * (docs/feat/mobile-projects.md §6 "Link diagnosis", F1).
 *
 * Through a REAL relay with an injected clock: a phone dial for an id no daemon
 * registered is held, then closed `4404` after the stream opened and before any
 * handshake. The client's channel drops the close code (`ws-channel.ts`
 * `onClose()` takes none), so `openComputer` reads it from its own diagnostics
 * wrapper. Three such polls must still say "not reachable", flagged `absent`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { encodeBase64Url } from "@tentacle/protocol";
import { systemRandom } from "@tentacle/transport/noise";
import { type RunningRelay, startRelay } from "../../relay/src/server.ts";
import type { StoredComputer } from "../src/computer-store.ts";
import { openComputer } from "../src/connection.ts";
import { MAYBE_RESET_STREAK, createLinkDiagnoser } from "../src/link-diagnosis.ts";
import type { RNWebSocketCtor } from "../src/rn-websocket.ts";

const relays: RunningRelay[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) {
    relay.stop();
  }
});

/** RN's WebSocket shape over Bun's (the pairing-e2e adapter, without the Origin). */
const PhoneWebSocket = class {
  readonly #ws: WebSocket;
  constructor(url: string, protocols?: string | string[]) {
    this.#ws = new WebSocket(url, { protocols } as never);
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

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await Bun.sleep(5);
  }
}

describe("a stopped project over the relay (4404)", () => {
  test(`${MAYBE_RESET_STREAK} polls of an unregistered relay id stay "unreachable" + absent, never maybe-reset (mutation: drop the 4404 read in connection.ts → red)`, async () => {
    let now = 1_000_000;
    const relay = startRelay({ host: "127.0.0.1", port: 0, now: () => now, sweepMs: 60_000 });
    relays.push(relay);
    const base = relay.url.replace(/^http/, "ws");
    const record: StoredComputer = {
      id: "mac.0123456789abcdef",
      name: "MacBook",
      computerKey: encodeBase64Url(new Uint8Array(32).fill(9)),
      deviceKey: encodeBase64Url(new Uint8Array(32).fill(3)),
      addresses: [`${base}/d/${"A".repeat(22)}/e2e`],
      deviceName: "MacBook",
      pairedAt: 1,
    };
    const diagnosis = createLinkDiagnoser();
    for (let poll = 0; poll < MAYBE_RESET_STREAK; poll += 1) {
      const attempt = openComputer(record, {
        WebSocket: PhoneWebSocket,
        random: systemRandom,
        diagnosis,
      }).then(
        () => "linked",
        () => "failed",
      );
      // The phone's stream is held while nobody is registered; time passes, the
      // sweep closes it `4404`.
      await until(() => relay.core.heldCount > 0);
      now += 60_000;
      relay.sweep();
      expect(await attempt).toBe("failed");
      expect(diagnosis.absent()).toBe(true);
    }
    expect(diagnosis.current()).toBe("unreachable");
  }, 30_000);
});
