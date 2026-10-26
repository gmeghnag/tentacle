/**
 * A tiny fake Docker Engine API server on a unix socket, for `ssh-dialer.test.ts`.
 * It is SPAWNED (not imported) by the test with `FAKE_ENGINE_SOCKET` set, and
 * answers the handful of requests the real client sends over the ssh dialer:
 * `_ping` (API 1.52), container create/start/inspect, exec create, exec start
 * (the `101` hijack that echoes stdin back as multiplexed stdout frames), and
 * exec inspect. One process serves many connections (the client dials fresh per
 * request, exactly like `dial-stdio`); a streaming (hijacked) connection ends
 * when its stdin EOFs.
 *
 * It uses the listener-level `socket: { data, end, close }` handlers (the only
 * per-connection events Bun exposes here) plus a `WeakMap` of per-connection
 * state — a Bun socket object has no `.on()`.
 */
import { appendFileSync } from "node:fs";

const socketPath = process.env.FAKE_ENGINE_SOCKET;
if (!socketPath) {
  process.stderr.write("FAKE_ENGINE_SOCKET unset\n");
  process.exit(2);
}
const LOG = process.env.FAKE_ENGINE_LOG;
const log = (m: string): void => {
  if (LOG) {
    try {
      appendFileSync(LOG, `${m}\n`);
    } catch {
      // best-effort logging
    }
  }
};
const enc = new TextEncoder();
const dec = new TextDecoder();

type S = {
  write(b: Uint8Array | string): unknown;
  end(): void;
};
type Conn = { buf: Uint8Array; streaming: boolean };
const conns = new WeakMap<object, Conn>();

function reply(s: S, status: number, body = "", extra = ""): void {
  const reason =
    status === 200 ? "OK" : status === 201 ? "Created" : status === 204 ? "No Content" : "X";
  s.write(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`);
  s.end();
}

function data(s: S, bytes: Uint8Array): void {
  let conn = conns.get(s);
  if (!conn) {
    conn = { buf: new Uint8Array(0), streaming: false };
    conns.set(s, conn);
  }
  const next = new Uint8Array(conn.buf.length + bytes.length);
  next.set(conn.buf, 0);
  next.set(bytes, conn.buf.length);
  conn.buf = next;

  // A hijacked (exec start) connection: echo stdin back as multiplexed frames.
  if (conn.streaming) {
    if (conn.buf.length > 0) {
      const out = new Uint8Array(8 + conn.buf.length);
      out[0] = 1; // stream 1 = stdout
      new DataView(out.buffer, 0, out.byteLength).setUint32(4, conn.buf.length);
      out.set(conn.buf, 8);
      s.write(out);
    }
    conn.buf = new Uint8Array(0);
    return;
  }

  let headEnd = -1;
  for (let i = 0; i + 3 < conn.buf.length; i++) {
    if (
      conn.buf[i] === 13 &&
      conn.buf[i + 1] === 10 &&
      conn.buf[i + 2] === 13 &&
      conn.buf[i + 3] === 10
    ) {
      headEnd = i;
      break;
    }
  }
  if (headEnd === -1) {
    return;
  }
  const headText = dec.decode(conn.buf.subarray(0, headEnd));
  const lines = headText.split("\r\n");
  const [first = ""] = lines;
  const [method = "", rawPath = ""] = first.split(" ");
  let length = 0;
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (line.slice(0, i).trim().toLowerCase() === "content-length") {
      length = Number(line.slice(i + 1).trim());
    }
  }
  const headBytes = enc.encode(`${headText}\r\n\r\n`).length;
  const p = rawPath.split("?")[0] ?? "";
  log(`REQ ${method} ${p}`);

  if (p.includes("/exec/") && p.endsWith("/start")) {
    conn.streaming = true;
    s.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    conn.buf = new Uint8Array(0);
    return;
  }

  if (conn.buf.length < headBytes + length) {
    return; // body not complete yet
  }
  conn.buf = new Uint8Array(0);
  if (p === "/_ping") {
    reply(s, 200, "OK", "Api-Version: 1.52\r\nContent-Type: text/plain\r\n");
  } else if (p.includes("/containers/") && p.endsWith("/exec")) {
    reply(s, 201, JSON.stringify({ Id: "e1" }));
  } else if (p.includes("/exec/") && p.endsWith("/json")) {
    reply(s, 200, JSON.stringify({ Running: false, ExitCode: 0 }));
  } else if (p.includes("/containers/create")) {
    reply(s, 201, JSON.stringify({ Id: "c1", Warnings: [] }));
  } else if (p.endsWith("/start")) {
    reply(s, 204);
  } else if (p.endsWith("/json")) {
    reply(s, 200, JSON.stringify({ Id: "c1", State: { Running: true } }));
  } else {
    reply(s, 200, "{}");
  }
}

function end(s: S): void {
  // The client half-closed (stdin EOF). On a streaming (hijacked) connection
  // that is the exec's stdin EOF — end the stream so the bridge can exit.
  const conn = conns.get(s);
  if (conn?.streaming) {
    s.end();
  }
}

Bun.listen({
  unix: socketPath,
  socket: {
    data,
    end,
    close(): void {},
  },
} as unknown as Parameters<typeof Bun.listen>[0]);
process.stderr.write("FAKE-ENGINE-READY\n");
