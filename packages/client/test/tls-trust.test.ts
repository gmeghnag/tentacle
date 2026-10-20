import { describe, expect, test } from "bun:test";
/**
 * `connect`'s TLS trust (docs/feat/client-tls-trust.md): a `wss://` daemon
 * whose cert is not in the system store is unreachable without a trust anchor.
 * The change threads a `tls` object (the same shape the k8s pod path uses)
 * through `connectWebSocket` / `webSocketChannelFactory` into the WebSocket
 * `init`. These tests run over REAL sockets against a self-signed `Bun.serve`,
 * so they pin the exact property — the socket fails without a CA and opens only
 * when `tls.ca` is honoured — plus the insecure knob and the token+TLS
 * composition.
 *
 * Red-before-green (AGENTS §9): run this file against the pre-change
 * `ws-channel.ts` (one that ignores `options.tls`) and the "ca opens",
 * "insecure opens" and "composition" cases reject/fail; after the fix they pass.
 */
import { readFileSync } from "node:fs";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ChannelError } from "../src/link-machine.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { type TlsOptions, connectWebSocket, webSocketChannelFactory } from "../src/ws-channel.ts";

// Test-only self-signed pair for 127.0.0.1 (SAN IP:127.0.0.1, long-lived) and an
// unrelated CA that did NOT sign the server — both checked in so the suite is
// hermetic (no `openssl` dependency at test time).
const SERVER_CA = readFileSync(new URL("./fixtures/server.pem", import.meta.url), "utf8");
const SERVER_KEY = readFileSync(new URL("./fixtures/server-key.pem", import.meta.url), "utf8");
const OTHER_CA = readFileSync(new URL("./fixtures/other-ca.pem", import.meta.url), "utf8");

/**
 * A TLS WebSocket server that echoes a marker on open. Not the full
 * `startWsServer` (token/origin logic the TLS test does not need) — the minimal
 * `Bun.serve` with `tls` + `srv.upgrade` is what the client must trust.
 */
function startTlsServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: SERVER_CA, key: SERVER_KEY },
    fetch(req, srv) {
      if (req.headers.get("upgrade") === "websocket" && srv.upgrade(req)) {
        return undefined;
      }
      return new Response("not a websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send("tls-hello");
      },
      message() {},
    },
  });
  return { url: `wss://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Rejects if `promise` does not settle within `ms` — a hang is a failure, not a wait. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle in ${ms}ms`)), ms),
    ),
  ]);
}

describe("connectWebSocket trusts a self-signed daemon (real socket)", () => {
  test("fails with no CA, opens with tls.ca, rejects a CA that did not sign it", async () => {
    const { url, stop } = startTlsServer();
    try {
      // The system store does not contain the self-signed CA → the socket errors.
      await expect(settlesWithin(connectWebSocket(url), 5000)).rejects.toThrow(/failed to connect/);

      // The CA (the self-signed cert itself) is the trust anchor → it opens.
      // RED on the pre-change code: `options.tls` ignored → this still rejects.
      const channel = await settlesWithin(connectWebSocket(url, { tls: { ca: SERVER_CA } }), 5000);
      channel.close();

      // Non-vacuity: a CA that did NOT sign the server must NOT be accepted.
      await expect(
        settlesWithin(connectWebSocket(url, { tls: { ca: OTHER_CA } }), 5000),
      ).rejects.toThrow(/failed to connect/);
    } finally {
      stop();
    }
  });

  test("tls.rejectUnauthorized:false opens (the insecure dev knob; the correct one — not disableTlsCerts)", async () => {
    const { url, stop } = startTlsServer();
    try {
      // RED on pre-change code, and the mutation that proves the RIGHT knob:
      // if the code used `disableTlsCerts` (a fetch-only knob the WS ignores),
      // this would reject while the `tls.ca` case above passes.
      const channel = await settlesWithin(
        connectWebSocket(url, { tls: { rejectUnauthorized: false } }),
        5000,
      );
      channel.close();
    } finally {
      stop();
    }
  });
});

describe("token + TLS composition (the composed init, not a private field)", () => {
  // A WebSocket constructor that records the `init` it was built with and opens
  // immediately, so `webSocketChannelFactory` (which takes an injectable Ctor)
  // resolves and we can assert exactly what was handed to `new WebSocket(...)`.
  class CapturingWebSocket {
    static lastUrl: string | undefined;
    static lastInit: unknown;
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(url: string, init?: unknown) {
      CapturingWebSocket.lastUrl = url;
      CapturingWebSocket.lastInit = init;
      setTimeout(() => this.fire("open"), 0);
    }
    addEventListener(type: string, cb: (...args: unknown[]) => void): void {
      if (this.listeners[type] === undefined) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(cb);
    }
    send(): void {}
    close(): void {}
    private fire(type: string): void {
      for (const cb of this.listeners[type] ?? []) void cb();
    }
  }

  test("token and tls are both in the init the socket is constructed with", async () => {
    CapturingWebSocket.lastInit = undefined;
    const tls: TlsOptions = { ca: SERVER_CA };
    const dial = webSocketChannelFactory(
      "ws://127.0.0.1:4000",
      { token: "sekret", tls },
      {
        WebSocket: CapturingWebSocket as never,
      },
    );
    const channel = await dial();
    channel.close();
    // The token header is still present AND the tls object rides along.
    expect(CapturingWebSocket.lastInit).toEqual({
      headers: { Authorization: "Bearer sekret" },
      tls: { ca: SERVER_CA },
    });
    // `new URL(...).toString()` normalises the empty path to "/" (pre-existing
    // for the token-only `?token=` fallback too).
    expect(CapturingWebSocket.lastUrl).toBe("ws://127.0.0.1:4000/?token=sekret");
  });

  test("tls alone (no token) yields an init with tls and no headers", async () => {
    CapturingWebSocket.lastInit = undefined;
    const dial = webSocketChannelFactory(
      "wss://127.0.0.1:4000",
      { tls: { rejectUnauthorized: false } },
      {
        WebSocket: CapturingWebSocket as never,
      },
    );
    const channel = await dial();
    channel.close();
    expect(CapturingWebSocket.lastInit).toEqual({ tls: { rejectUnauthorized: false } });
    expect(CapturingWebSocket.lastUrl).toBe("wss://127.0.0.1:4000");
  });

  test("neither token nor tls: the socket is built with no init (unchanged path)", async () => {
    CapturingWebSocket.lastInit = undefined;
    const dial = webSocketChannelFactory(
      "ws://127.0.0.1:4000",
      {},
      {
        WebSocket: CapturingWebSocket as never,
      },
    );
    const channel = await dial();
    channel.close();
    expect(CapturingWebSocket.lastInit).toBeUndefined();
    expect(CapturingWebSocket.lastUrl).toBe("ws://127.0.0.1:4000");
  });
});

describe("the real daemon handshake over TLS (the exact factory `connect` uses)", () => {
  // The full stack, not just the socket: `startWsServer` serving `wss://` with
  // the self-signed cert, dialed through `webSocketChannelFactory` (what
  // `connectTui` wires into `RemoteClient`).
  const host = new SessionHost({
    defaultCwd: "/tmp",
    createAgent: () => {
      throw new Error("handshake only: no agent");
    },
  });

  test("no CA → ChannelError; tls.ca → initialize succeeds; insecure → initialize succeeds", async () => {
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: host,
      tls: { cert: SERVER_CA, key: SERVER_KEY },
    });
    try {
      // Without a trust anchor the upgrade dies in the TLS layer (close 1006)
      // → the factory classifies it `unreachable`, never a silent success.
      let dialError: unknown;
      try {
        await webSocketChannelFactory(server.url)();
      } catch (error) {
        dialError = error;
      }
      expect(dialError).toBeInstanceOf(ChannelError);
      expect((dialError as ChannelError).kind).toBe("unreachable");

      for (const tls of [
        { ca: SERVER_CA },
        { rejectUnauthorized: false },
      ] satisfies readonly TlsOptions[]) {
        const client = new RemoteClient(
          await webSocketChannelFactory(server.url, { tls })(),
          new PermissionBroker(),
        );
        try {
          const init = await client.initialize();
          expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
        } finally {
          client.close();
        }
      }
    } finally {
      server.stop();
    }
  });

  // Regression (review Finding 1): the factory's classifying probe is a plain
  // GET that must itself complete the TLS handshake to read the daemon's 401.
  // Before the fix the probe carried no `tls`, so against a `wss://` daemon its
  // own handshake failed → a bad token's 1002 was classified `rejected`
  // (transient → an infinite redial) instead of `unauthorized` (terminal).
  test("a bad token against a TLS daemon is `unauthorized` (terminal), not `rejected` (redial loop)", async () => {
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => {
        throw new Error("handshake only: no agent");
      },
    });
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: host,
      token: "good",
      tls: { cert: SERVER_CA, key: SERVER_KEY },
    });
    try {
      // The trust anchor is correct (so the socket would open), but the token
      // is wrong → the daemon 401s the upgrade (close 1002). The probe must
      // read that 401 to classify it `unauthorized`.
      // RED on the pre-fix code: the probe lacks `tls` → handshake fails →
      // probe null → classified `rejected` here.
      let dialError: unknown;
      try {
        await webSocketChannelFactory(server.url, { token: "bad", tls: { ca: SERVER_CA } })();
      } catch (error) {
        dialError = error;
      }
      expect(dialError).toBeInstanceOf(ChannelError);
      expect((dialError as ChannelError).kind).toBe("unauthorized");

      // The correct token + CA still opens (the fix did not break the happy path).
      const client = new RemoteClient(
        await webSocketChannelFactory(server.url, { token: "good", tls: { ca: SERVER_CA } })(),
        new PermissionBroker(),
      );
      try {
        const init = await client.initialize();
        expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      } finally {
        client.close();
      }
    } finally {
      server.stop();
    }
  });
});
