/**
 * The browser host = the HUB (docs/feat/browser-inspect.md §1). Chrome spawns
 * it (native messaging, F5) and it lives while the extension's port lives; it
 * listens on `<configDir>/browser/hub.sock` (0600, dir 0700) and every
 * tentacle daemon on this Mac dials it as a client. It carries only browser
 * ops and events, never session frames, and it is the ONE arbiter of tab
 * ownership (§6): an op naming a tab the session does not own is refused HERE.
 *
 *   daemon ──newline JSON {id, op…}──▶ hub ──native frame {id, op…}──▶ extension
 *   daemon ◀─{id, ok, result|error}── hub ◀─native frame {id, ok…}──── extension
 *
 * The extension's own events (`tab_closed`, `detached`, `handover`) arrive on
 * the same stream; the hub applies the ownership effect and broadcasts.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { join } from "node:path";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_LINK_VERSION,
  type ClaimedBy,
  HUB_MAX_LINE_BYTES,
  HubEvent,
  HubHello,
  HubOp,
  NativeDecoder,
  Ownership,
  encodeNative,
} from "@tentacle/browser";
import { ByteFramer } from "@tentacle/transport";

/** macOS `sun_path` is 104 bytes, the terminating NUL included. */
const SUN_PATH_MAX = 103;
export const CHROME_CLOSED_MESSAGE =
  "Chrome closed during the action — it may or may not have happened";
export const NO_EXTENSION_MESSAGE = "Chrome isn't running with the tentacle extension";
export const VERSION_MESSAGE = "browser link version mismatch — run `tentacle browser install`";

export function browserDir(configDir: string): string {
  return join(configDir, "browser");
}
export function hubSocketPath(configDir: string): string {
  return join(browserDir(configDir), "hub.sock");
}

/** The origin Chrome passes as argv[1] (F5); only the pinned extension may spawn us. */
export function originAllowed(
  argv1: string | undefined,
  extensionId: string = BROWSER_EXTENSION_ID,
): boolean {
  return argv1 === `chrome-extension://${extensionId}/`;
}

/** True when something answers on `path` (a live hub). */
export function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

interface Pending {
  readonly conn: Conn;
  readonly reqId: number;
  readonly op: HubOp;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Conn {
  readonly socket: Socket;
  daemonId: string | undefined;
}

export interface HubOptions {
  readonly configDir: string;
  /** Host → Chrome bytes (stdout). */
  readonly toChrome: (bytes: Uint8Array) => void;
  /** An op the extension never answers fails after this (default 30 s). */
  readonly opTimeoutMs?: number;
  readonly littleEndian?: boolean;
}

export interface Hub {
  /** Bind the socket. `false` when a LIVE hub already owns it (second profile). */
  start(): Promise<boolean>;
  /** Bytes from Chrome (stdin). */
  fromChrome(chunk: Uint8Array): void;
  /** Chrome's stdin ended: fail every pending op, tell the daemons, shut down. */
  chromeClosed(): Promise<void>;
  stop(): Promise<void>;
  readonly ownership: Ownership;
}

export function createHub(options: HubOptions): Hub {
  const sock = hubSocketPath(options.configDir);
  const timeoutMs = options.opTimeoutMs ?? 30_000;
  const ownership = new Ownership();
  const conns = new Set<Conn>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let server: Server | undefined;
  let closed = false;

  const send = (conn: Conn, value: unknown): void => {
    if (!conn.socket.destroyed) conn.socket.write(`${JSON.stringify(value)}\n`);
  };
  const broadcast = (event: HubEvent): void => {
    for (const c of conns) if (c.daemonId !== undefined) send(c, event);
  };
  const toExt = (value: unknown): boolean => {
    try {
      options.toChrome(encodeNative(value, options.littleEndian));
      return true;
    } catch {
      return false;
    }
  };
  const settle = (id: number, reply: Record<string, unknown>): void => {
    const p = pending.get(id);
    if (p === undefined) return;
    pending.delete(id);
    clearTimeout(p.timer);
    send(p.conn, { id: p.reqId, ...reply });
  };

  const decoder = new NativeDecoder(
    {
      onMessage: (msg) => onExtension(msg),
      onViolation: () => void hubApi.chromeClosed(),
    },
    options.littleEndian,
  );

  function onExtension(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.id === "number") {
      const p = pending.get(m.id);
      if (p === undefined) return;
      if (m.ok === true) {
        // The tab the extension opened for this session is the session's now.
        const result = m.result;
        if (p.op.op === "open" && typeof result === "object" && result !== null) {
          const tab = (result as { tab?: unknown }).tab;
          if (typeof tab === "number") ownership.addTab(p.op.sessionUid, tab);
        }
        settle(m.id, { ok: true, result });
      } else {
        settle(m.id, { ok: false, error: typeof m.error === "string" ? m.error : "failed" });
      }
      return;
    }
    if (m.event === "handover" && typeof m.sessionUid === "string" && typeof m.tab === "number") {
      ownership.addTab(m.sessionUid, m.tab, true);
      return;
    }
    const ev = HubEvent.safeParse(m);
    if (!ev.success) return;
    if (ev.data.event === "tab_closed") ownership.dropTab(ev.data.tab);
    broadcast(ev.data);
  }

  function onOp(conn: Conn, reqId: number, op: HubOp): void {
    const daemonId = conn.daemonId;
    if (daemonId === undefined) return;
    const c: ClaimedBy = { daemonId, sessionUid: op.sessionUid };
    const refused = refusal(c, op);
    if (refused !== undefined) {
      send(conn, { id: reqId, ok: false, error: refused });
      return;
    }
    // The extension supplies titles/origins; the hub says which tabs are ours.
    const extra = op.op === "tabs" ? { tabs: ownership.tabsOf(op.sessionUid) } : {};
    forward(conn, reqId, op, extra);
  }

  /** The ownership verdict on an op: a message, or undefined = go ahead. */
  function refusal(c: ClaimedBy, op: HubOp): string | undefined {
    if (op.op === "claim") {
      const r = ownership.claim(c);
      return r.ok ? undefined : r.error;
    }
    if (op.op === "release") {
      return ownership.release(c) ? undefined : "this session does not hold the browser";
    }
    if ("tab" in op && op.tab !== undefined) {
      const r = ownership.check(c, op.tab);
      return r.ok ? undefined : r.error;
    }
    return ownership.holds(c) ? undefined : "this session does not hold the browser";
  }

  function forward(conn: Conn, reqId: number, op: HubOp, extra: Record<string, unknown>): void {
    const id = nextId++;
    const timer = setTimeout(() => {
      settle(id, { ok: false, error: "the browser did not answer in time" });
    }, timeoutMs);
    pending.set(id, { conn, reqId, op, timer });
    if (!toExt({ id, ...op, ...extra })) {
      settle(id, { ok: false, error: "the request is too large for Chrome (over 1 MB)" });
    }
  }

  function onConnection(socket: Socket): void {
    const conn: Conn = { socket, daemonId: undefined };
    conns.add(conn);
    const framer = new ByteFramer(
      {
        onLine: (line) => {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return socket.destroy();
          }
          if (conn.daemonId === undefined) {
            const hello = HubHello.safeParse(value);
            const v = (value as { version?: unknown } | null)?.version;
            if (!hello.success) {
              send(conn, {
                ok: false,
                error: v === BROWSER_LINK_VERSION ? "bad hello" : VERSION_MESSAGE,
              });
              return void socket.end();
            }
            conn.daemonId = hello.data.daemonId;
            return send(conn, { ok: true });
          }
          const { id, ...rest } = (value ?? {}) as { id?: unknown };
          const op = HubOp.safeParse(rest);
          if (typeof id !== "number" || !op.success) return socket.destroy();
          onOp(conn, id, op.data);
        },
        onViolation: () => socket.destroy(),
      },
      HUB_MAX_LINE_BYTES,
    );
    socket.on("data", (d) => framer.push(new Uint8Array(d)));
    socket.on("error", () => {});
    socket.on("close", () => {
      conns.delete(conn);
      for (const [id, p] of pending) {
        if (p.conn === conn) {
          clearTimeout(p.timer);
          pending.delete(id);
        }
      }
      if (conn.daemonId !== undefined) {
        for (const sessionUid of ownership.releaseDaemon(conn.daemonId)) {
          toExt({ op: "release", sessionUid });
        }
      }
    });
  }

  const hubApi: Hub = {
    ownership,
    async start() {
      const dir = browserDir(options.configDir);
      if (sock.length > SUN_PATH_MAX) {
        throw new Error(`hub socket path is too long (${sock.length} > ${SUN_PATH_MAX}): ${sock}`);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (lstatSync(sock, { throwIfNoEntry: false }) !== undefined) {
        if (await probeSocket(sock)) return false;
        rmSync(sock, { force: true });
      }
      const s = createServer(onConnection);
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(sock, () => resolve());
      });
      chmodSync(sock, 0o600);
      return true;
    },
    fromChrome(chunk) {
      decoder.push(chunk);
    },
    async chromeClosed() {
      if (closed) return;
      for (const id of [...pending.keys()]) settle(id, { ok: false, error: CHROME_CLOSED_MESSAGE });
      broadcast({ event: "chrome_closed" });
      ownership.reset();
      await hubApi.stop();
    },
    async stop() {
      closed = true;
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      const s = server;
      server = undefined;
      for (const c of conns) c.socket.end();
      if (s !== undefined) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
        rmSync(sock, { force: true });
      }
    },
  };
  return hubApi;
}

/**
 * `tentacle __browser-host` (spawned by Chrome through the wrapper). Returns
 * the exit code; a second host (another profile) finds a live hub and exits.
 */
export async function browserHostMain(
  argv1: string | undefined,
  configDir: string,
  io: {
    readonly stdin: AsyncIterable<Uint8Array>;
    readonly stdout: (bytes: Uint8Array) => void;
    readonly err: (text: string) => void;
  },
  extensionId: string = BROWSER_EXTENSION_ID,
): Promise<number> {
  if (!originAllowed(argv1, extensionId)) {
    io.err("browser host: refusing an unexpected caller origin\n");
    return 1;
  }
  const hub = createHub({ configDir, toChrome: io.stdout });
  if (!(await hub.start())) {
    io.err("browser host: another Chrome profile already holds the hub\n");
    return 1;
  }
  for await (const chunk of io.stdin) hub.fromChrome(chunk);
  // stdin EOF = Chrome quit (U6).
  await hub.chromeClosed();
  return 0;
}
