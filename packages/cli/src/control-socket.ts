/**
 * A detached run's control socket (docs/feat/detached-handover.md): the
 * relay listens, an `attach` dials, to hand the run's session over. Laptop
 * only, 0600 in the 0700 run dir: no pod input reaches it. It carries exactly
 * two ops, never the session protocol (that stays on the one RPC path):
 *
 * - `prepare{sessionId}`: the relay freezes its policy and disarms its exit
 *   net, and stops counting an idle exit. The attacher then opens the session.
 * - `commit`: irrevocable; the relay's last save is done before the ack.
 *
 * The connection is the lease: closed before `commit`, the hand-over aborts
 * (a SIGKILLed peer closes it within milliseconds). Frames are newline JSON,
 * capped at 4 KiB, versioned and strictly parsed; the IO is thin `node:net`.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { join } from "node:path";

export const CONTROL_SCHEMA_VERSION = 1;
/** A frame is never longer: a peer that sends more is cut off. */
export const CONTROL_MAX_BYTES = 4096;
/** macOS `sun_path` is 104 bytes, the terminating NUL included. */
const SUN_PATH_MAX = 103;

export type ControlRequest =
  | { readonly op: "prepare"; readonly sessionId: string }
  | { readonly op: "commit" };

export type ControlRefusal =
  /** The relay's exit plan is final. */
  | "leaving"
  /** Another attacher is mid-hand-over. */
  | "busy"
  /** Already committed: join as a plain client. */
  | "handed_over"
  /** Not this run's session. */
  | "session"
  /** Another control schema. */
  | "version"
  /** The relay is stopping. */
  | "stopped"
  /** Not a frame of this protocol, or out of order. */
  | "invalid";
const REFUSALS: readonly string[] = [
  "leaving",
  "busy",
  "handed_over",
  "session",
  "version",
  "stopped",
  "invalid",
] satisfies readonly ControlRefusal[];

export type ControlReply =
  | { readonly ok: true; readonly appVersion?: string }
  | { readonly ok: false; readonly reason: ControlRefusal };

export type ControlParse =
  | { readonly ok: true; readonly request: ControlRequest }
  | { readonly ok: false; readonly reason: "version" | "invalid" };

function object(text: string): Record<string, unknown> | null {
  if (Buffer.byteLength(text) > CONTROL_MAX_BYTES) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One request frame, strict. Pure. */
export function parseControl(line: string): ControlParse {
  const r = object(line);
  if (r === null || typeof r.schemaVersion !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (r.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    return { ok: false, reason: "version" };
  }
  if (r.op === "prepare" && typeof r.sessionId === "string" && r.sessionId !== "") {
    return { ok: true, request: { op: "prepare", sessionId: r.sessionId } };
  }
  if (r.op === "commit") {
    return { ok: true, request: { op: "commit" } };
  }
  return { ok: false, reason: "invalid" };
}

/** One reply frame, strict; `null` when it is not one. Pure. */
export function parseReply(line: string): ControlReply | null {
  const r = object(line);
  if (r === null || r.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    return null;
  }
  if (r.ok === true) {
    return {
      ok: true,
      // No `autoAccept`: the run's bit is the laptop's owner.json, never a
      // second carrier (docs/fix/detach-live.md B1).
      ...(typeof r.appVersion === "string" ? { appVersion: r.appVersion } : {}),
    };
  }
  if (r.ok === false && typeof r.reason === "string" && REFUSALS.includes(r.reason)) {
    return { ok: false, reason: r.reason as ControlRefusal };
  }
  return null;
}

const frame = (value: object): string =>
  `${JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, ...value })}\n`;

/**
 * Where the run's control socket lives: `<runDir>/control.sock`, or, when that
 * path is too long for a unix socket, `<tmp>/tentacle-<uid>/<stem>.sock` in a
 * dir that is ours and 0700 (made so if absent). `null`: no safe place, so no
 * socket (an `attach` then gets S2's refusal).
 */
export function controlSocketPath(
  runDir: string,
  stem: string,
  env: { readonly tmp: string; readonly uid: number },
): string | null {
  const inRun = join(runDir, "control.sock");
  if (Buffer.byteLength(inRun) <= SUN_PATH_MAX) {
    return inRun;
  }
  const dir = join(env.tmp, `tentacle-${env.uid}`);
  const path = join(dir, `${stem}.sock`);
  if (Buffer.byteLength(path) > SUN_PATH_MAX) {
    return null;
  }
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    // Exists (or cannot be made: the check below says no).
  }
  try {
    // A real dir (not a link), private, and ours: nobody else can bind or dial there.
    const st = lstatSync(dir);
    const ours = st.uid === env.uid && env.uid === (process.getuid?.() ?? env.uid);
    return st.isDirectory() && (st.mode & 0o777) === 0o700 && ours ? path : null;
  } catch {
    return null;
  }
}

/** Read newline frames off `socket`; a frame over the cap closes it. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      onLine(line);
    }
    if (Buffer.byteLength(buffer) > CONTROL_MAX_BYTES) {
      socket.destroy();
    }
  });
}

/** One accepted connection, as the relay sees it. */
export interface ControlPeer {
  close(): void;
}

export interface ControlHandlers {
  /** Answer one request (in order, one at a time per connection). */
  onRequest(request: ControlRequest, peer: ControlPeer): Promise<ControlReply>;
  /** The connection went away (or was closed). */
  onClose(peer: ControlPeer): void;
}

export interface ControlServer {
  /** Stop listening, drop every connection, unlink the socket file. */
  close(): void;
}

/** Listen on `path` (unlinked first, then 0600, the resident's pattern). */
export async function serveControl(
  path: string,
  handlers: ControlHandlers,
): Promise<ControlServer> {
  rmSync(path, { force: true });
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    const peer: ControlPeer = { close: () => socket.destroy() };
    let queue = Promise.resolve();
    socket.on("error", () => {});
    socket.on("close", () => {
      open.delete(socket);
      handlers.onClose(peer);
    });
    lines(socket, (line) => {
      queue = queue.then(async () => {
        const parsed = parseControl(line);
        const reply: ControlReply = parsed.ok
          ? await handlers
              .onRequest(parsed.request, peer)
              .catch((): ControlReply => ({ ok: false, reason: "invalid" }))
          : { ok: false, reason: parsed.reason };
        if (!socket.destroyed) {
          socket.write(frame(reply));
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return {
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
      rmSync(path, { force: true });
    },
  };
}

/** The attacher's end of one connection. */
export interface ControlConn {
  /** One request; rejects when the connection closes first or the reply is unreadable. */
  send(request: ControlRequest, timeoutMs?: number): Promise<ControlReply>;
  /** Resolves when the connection is gone. */
  readonly closed: Promise<void>;
  close(): void;
}

/** Dial `path`; `null` when nothing listens there (`ENOENT`, `ECONNREFUSED`, …). */
export function dialControl(path: string): Promise<ControlConn | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const waiting: ((line: string | null) => void)[] = [];
    let gone = false;
    let markClosed = (): void => {};
    const closed = new Promise<void>((r) => {
      markClosed = r;
    });
    socket.once("error", () => {
      if (!gone) resolve(null);
    });
    socket.on("close", () => {
      gone = true;
      markClosed();
      for (const w of waiting.splice(0)) w(null);
    });
    socket.once("connect", () => {
      socket.on("error", () => {});
      lines(socket, (line) => waiting.shift()?.(line));
      resolve({
        closed,
        close: () => socket.destroy(),
        send: (request, timeoutMs = 15_000) =>
          new Promise<ControlReply>((ok, fail) => {
            if (gone) {
              fail(new Error("the control connection is closed"));
              return;
            }
            const timer = setTimeout(() => {
              const i = waiting.indexOf(answer);
              if (i >= 0) waiting.splice(i, 1);
              fail(new Error(`no answer within ${timeoutMs / 1000}s`));
            }, timeoutMs);
            const answer = (line: string | null): void => {
              clearTimeout(timer);
              const reply = line === null ? null : parseReply(line);
              if (reply === null) {
                fail(
                  new Error(
                    line === null ? "the control connection closed" : "an unreadable reply",
                  ),
                );
                return;
              }
              ok(reply);
            };
            waiting.push(answer);
            socket.write(frame(request));
          }),
      });
    });
  });
}
