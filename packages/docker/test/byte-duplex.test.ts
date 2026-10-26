import { afterAll, describe, expect, test } from "bun:test";
/**
 * `socketDialer` over REAL loopback sockets (`Bun.listen` on 127.0.0.1 and on a
 * unix path) — the eval's unproven transport points: half-close over TCP and
 * TLS, TLS verification, mTLS, partial writes + drain, and actionable dial
 * errors. Hermetic: the TLS fixtures are the checked-in self-signed test pair
 * from `packages/client/test/fixtures/` (SAN IP:127.0.0.1, CN
 * tentacle-test-daemon, valid to 2036), copied here so the package is
 * self-contained; `server.pem` doubles as the CA (it is self-signed) and as the
 * mTLS client certificate. `other-ca.pem` is an unrelated CA.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, TCPSocketListener, UnixSocketListener } from "bun";
import { type ByteDuplex, type SocketEndpoint, socketDialer } from "../src/byte-duplex.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const CERT = fixture("server.pem");
const KEY = fixture("server-key.pem");
const OTHER_CA = fixture("other-ca.pem");

const enc = new TextEncoder();
const dec = new TextDecoder();

// macOS caps a unix socket path at 104 bytes: keep the dir short.
const dir = mkdtempSync(join(tmpdir(), "tdk-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let socketSeq = 0;
const socketPath = (): string => join(dir, `s${socketSeq++}.sock`);

interface ServerLog {
  data: string;
  events: string[];
  handshakeOk?: boolean;
}

/**
 * An echo-after-EOF server: collects what it reads; on the client's FIN
 * (`end`) it replies `got:<byte count>` and closes — only possible if the
 * client half-closed (a full close would leave nobody to read the reply).
 */
function halfCloseHandlers(log: ServerLog) {
  return {
    data(_s: Socket<undefined>, bytes: Buffer) {
      log.data += bytes.toString();
    },
    end(s: Socket<undefined>) {
      log.events.push("end");
      s.write(`got:${log.data.length}`);
      s.end();
    },
    close() {
      log.events.push("close");
    },
    handshake(_s: Socket<undefined>, ok: boolean) {
      log.handshakeOk = ok;
    },
  };
}

type Listener = TCPSocketListener<undefined> | UnixSocketListener<undefined>;
const listeners: Listener[] = [];
afterAll(() => {
  for (const l of listeners) {
    l.stop(true);
  }
});

function listenTcp(log: ServerLog, tls?: Record<string, unknown>): TCPSocketListener<undefined> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: halfCloseHandlers(log),
    ...(tls ? { tls } : {}),
  } as unknown as Parameters<typeof Bun.listen>[0]) as unknown as TCPSocketListener<undefined>;
  listeners.push(server);
  return server;
}

type TcpEp = Extract<SocketEndpoint, { kind: "tcp" }>;

/** A plaintext (opted-in insecure) tcp endpoint. */
function tcpEp(port: number): SocketEndpoint {
  return { kind: "tcp", host: "127.0.0.1", port, local: false, source: "test", insecure: true };
}

/** A verified-TLS tcp endpoint. */
function tlsEp(
  port: number,
  extra: Pick<TcpEp, "tls"> & Partial<Pick<TcpEp, "host">>,
): SocketEndpoint {
  return { kind: "tcp", host: "127.0.0.1", port, local: false, source: "test", ...extra };
}

/** Write `ping`, half-close, collect the reply until the peer ends. */
async function pingAfterHalfClose(duplex: ByteDuplex): Promise<{ reply: string; error?: Error }> {
  let reply = "";
  const ended = new Promise<Error | undefined>((resolve) => duplex.setOnEnd(resolve));
  duplex.setOnData((b) => {
    reply += dec.decode(b);
  });
  duplex.write(enc.encode("ping"));
  duplex.end();
  const error = await ended;
  return { reply, ...(error ? { error } : {}) };
}

describe("socketDialer: half-close (stdin EOF while still reading)", () => {
  test("TCP: end() sends FIN, the server can still reply, then onEnd", async () => {
    const log: ServerLog = { data: "", events: [] };
    const server = listenTcp(log);
    const duplex = await socketDialer(tcpEp(server.port))();
    const { reply, error } = await pingAfterHalfClose(duplex);
    expect(error).toBeUndefined();
    expect(reply).toBe("got:4");
    expect(log.data).toBe("ping");
    expect(log.events[0]).toBe("end");
    duplex.close();
  });

  test("unix: same", async () => {
    const log: ServerLog = { data: "", events: [] };
    const path = socketPath();
    listeners.push(Bun.listen({ unix: path, socket: halfCloseHandlers(log) }));
    const duplex = await socketDialer({ kind: "unix", path, local: true, source: "test" })();
    const { reply } = await pingAfterHalfClose(duplex);
    expect(reply).toBe("got:4");
    duplex.close();
  });

  test("end() waits for queued bytes before the FIN (nothing lost)", async () => {
    const log: ServerLog = { data: "", events: [] };
    const server = listenTcp(log);
    const duplex = await socketDialer(tcpEp(server.port))();
    const big = new Uint8Array(8 * 1024 * 1024).fill(0x61);
    let reply = "";
    const ended = new Promise<void>((resolve) => duplex.setOnEnd(() => resolve()));
    duplex.setOnData((b) => {
      reply += dec.decode(b);
    });
    duplex.write(big);
    expect(duplex.buffered).toBeGreaterThan(0); // the kernel did not take it all at once
    duplex.end();
    await ended;
    expect(log.data.length).toBe(big.length);
    expect(reply).toBe(`got:${big.length}`);
    duplex.close();
  });
});

describe("socketDialer: TLS", () => {
  test("trusted CA: round-trip + half-close over TLS", async () => {
    const log: ServerLog = { data: "", events: [] };
    const server = listenTcp(log, { cert: CERT, key: KEY });
    const ep = tlsEp(server.port, { tls: { ca: CERT, dir: "/fixtures" } });
    const duplex = await socketDialer(ep)();
    const { reply, error } = await pingAfterHalfClose(duplex);
    expect(error).toBeUndefined();
    expect(reply).toBe("got:4");
    duplex.close();
  });

  test("an unrelated CA → actionable TLS verification error, never a fallback", async () => {
    const server = listenTcp({ data: "", events: [] }, { cert: CERT, key: KEY });
    const ep = tlsEp(server.port, { tls: { ca: OTHER_CA, dir: "/my/certs" } });
    const err = await socketDialer(ep)().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/TLS verification of 127\.0\.0\.1:\d+ \(test\) failed/);
    expect(err?.message).toContain("check ca.pem in /my/certs");
  });

  test("a hostname not in the certificate → actionable TLS error", async () => {
    const server = Bun.listen({
      hostname: "localhost",
      port: 0,
      socket: halfCloseHandlers({ data: "", events: [] }),
      tls: { cert: CERT, key: KEY },
    });
    listeners.push(server);
    const ep = tlsEp(server.port, { host: "localhost", tls: { ca: CERT, dir: "/fixtures" } });
    const err = await socketDialer(ep)().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(
      /TLS verification of localhost:\d+ \(test\) failed \(ERR_TLS_CERT_ALTNAME_INVALID/,
    );
  });

  test("mTLS: the client certificate is presented and accepted", async () => {
    const log: ServerLog = { data: "", events: [] };
    const server = listenTcp(log, {
      cert: CERT,
      key: KEY,
      ca: CERT,
      requestCert: true,
      rejectUnauthorized: true,
    });
    const ep = tlsEp(server.port, { tls: { ca: CERT, cert: CERT, key: KEY, dir: "/fixtures" } });
    const duplex = await socketDialer(ep)();
    const { reply } = await pingAfterHalfClose(duplex);
    expect(reply).toBe("got:4");
    expect(log.handshakeOk).toBe(true);
    duplex.close();
  });

  test("mTLS required but no client cert → onEnd names cert.pem/key.pem", async () => {
    const server = listenTcp(
      { data: "", events: [] },
      { cert: CERT, key: KEY, ca: CERT, requestCert: true, rejectUnauthorized: true },
    );
    const ep = tlsEp(server.port, { tls: { ca: CERT, dir: "/my/certs" } });
    const duplex = await socketDialer(ep)();
    const { error } = await pingAfterHalfClose(duplex);
    expect(error?.message).toContain("client certificate, provide cert.pem/key.pem in /my/certs");
  });
});

describe("socketDialer: backpressure", () => {
  test("a 32 MiB write arrives whole and in order; buffered rises then drains; onDrain fires", async () => {
    let received = 0;
    let inOrder = true;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_s, bytes) {
          for (const b of bytes) {
            if (b !== (received & 0xff)) {
              inOrder = false;
            }
            received++;
          }
        },
      },
    });
    listeners.push(server);
    const duplex = await socketDialer(tcpEp(server.port))();
    const size = 32 * 1024 * 1024;
    const big = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      big[i] = i & 0xff;
    }
    let drains = 0;
    const drained = new Promise<void>((resolve) =>
      duplex.setOnDrain(() => {
        drains++;
        if (duplex.buffered === 0) {
          resolve();
        }
      }),
    );
    duplex.write(big);
    expect(duplex.buffered).toBeGreaterThan(0);
    await drained;
    expect(duplex.buffered).toBe(0);
    expect(drains).toBeGreaterThan(0);
    for (let i = 0; i < 200 && received < size; i++) {
      await Bun.sleep(5);
    }
    expect(received).toBe(size);
    expect(inOrder).toBe(true);
    duplex.close();
  });
});

describe("socketDialer: dial errors are actionable", () => {
  const dialErr = (ep: SocketEndpoint, connectTimeoutMs?: number): Promise<Error | undefined> =>
    socketDialer(ep, connectTimeoutMs ? { connectTimeoutMs } : {})().then(
      (d) => {
        d.close();
        return undefined;
      },
      (e: Error) => e,
    );

  test("missing unix socket → 'not found … is Docker Desktop running'", async () => {
    const err = await dialErr({
      kind: "unix",
      path: join(dir, "nope.sock"),
      local: true,
      source: 'context "x"',
    });
    expect(err?.message).toContain("Docker engine socket not found at");
    expect(err?.message).toContain('nope.sock (context "x")');
  });

  test("a stale socket nobody listens on → 'nothing is listening' (+ podman hint)", async () => {
    // A killed engine leaves its socket file behind (what a stopped Podman machine looks like).
    const path = join(dir, "podman-dead.sock");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.listen({unix:${JSON.stringify(path)},socket:{data(){}}});console.log("ready")`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    await child.stdout.getReader().read(); // "ready"
    child.kill("SIGKILL");
    await child.exited;
    const err = await dialErr({ kind: "unix", path, local: true, source: "test" });
    expect(err?.message).toContain("nothing is listening on");
    expect(err?.message).toContain("podman machine start");
  });

  test("a path that is not a socket → says so", async () => {
    const path = join(dir, "plain-file");
    writeFileSync(path, "");
    const err = await dialErr({ kind: "unix", path, local: true, source: "DOCKER_HOST" });
    expect(err?.message).toContain("is not a socket");
  });

  test("a socket without permission → 'permission denied … docker group'", async () => {
    const path = socketPath();
    listeners.push(Bun.listen({ unix: path, socket: { data() {} } }));
    chmodSync(path, 0o000);
    const err = await dialErr({ kind: "unix", path, local: true, source: "test" });
    chmodSync(path, 0o600);
    expect(err?.message).toContain("permission denied on");
    expect(err?.message).toContain("`docker` group");
  });

  test("a closed TCP port → 'connection refused'", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    const err = await dialErr(tcpEp(port));
    expect(err?.message).toContain(`connection refused by 127.0.0.1:${port}`);
  });

  test("a TLS server that never handshakes → connect timeout, no hang", async () => {
    // A plain TCP listener that accepts and says nothing: the TLS ClientHello is never answered.
    const server = listenTcp({ data: "", events: [] });
    const ep = tlsEp(server.port, { tls: { ca: CERT, dir: "/fixtures" } });
    const err = await dialErr(ep, 150);
    expect(err?.message).toContain("timed out connecting to 127.0.0.1:");
    expect(err?.message).toContain("after 150ms");
  });

  test("an aborted dial rejects with AbortError", async () => {
    const server = listenTcp({ data: "", events: [] });
    const ep = tlsEp(server.port, { tls: { ca: CERT, dir: "/fixtures" } });
    const ac = new AbortController();
    const pending = socketDialer(ep)(ac.signal).then(
      () => undefined,
      (e: Error) => e,
    );
    ac.abort();
    expect((await pending)?.name).toBe("AbortError");
  });
});
