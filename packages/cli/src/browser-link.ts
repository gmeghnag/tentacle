/**
 * One `BrowserLink` per daemon (docs/feat/browser-inspect.md §1), built like
 * the MCP hub: it dials the host's `hub.sock` lazily, re-dials on demand,
 * and reports `status()` for a UI. The worker and `serve` share this one
 * module; the `browser_*` tools (B4) will call `call()`.
 */
import { spawn } from "node:child_process";
import { type Socket, createConnection } from "node:net";
import { redactText } from "@tentacle/agent";
import { BROWSER_LINK_VERSION, HUB_MAX_LINE_BYTES, HubEvent, type HubOp } from "@tentacle/browser";
import { type BrowserToolset, createBrowserToolset } from "@tentacle/tools";
import { ByteFramer } from "@tentacle/transport";
import { NO_EXTENSION_MESSAGE, hubSocketPath } from "./browser-host.ts";

/** Q6: start Chrome in the background (`open -g`), macOS only; detached, output ignored. */
export function launchChrome(): Promise<void> {
  const child = spawn("open", ["-g", "-a", "Google Chrome"], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
  return Promise.resolve();
}

/**
 * The daemon's ONE browser toolset over its link (docs/feat/browser-inspect.md
 * B4): per-session masking keys and leases live here, so an agent rebuilt by
 * a settings change keeps them. The generic `redactText` runs last on every
 * text the tools return, whatever `tools.redactSecrets` says.
 */
export function browserToolsetOf(
  link: Pick<BrowserLink, "call">,
  launch: (() => Promise<void>) | undefined = process.platform === "darwin"
    ? launchChrome
    : undefined,
): BrowserToolset {
  return createBrowserToolset({
    backend: { call: (op) => link.call(op), ...(launch !== undefined ? { launch } : {}) },
    textNet: (text) => redactText(text),
  });
}

export type BrowserLinkStatus =
  | { readonly state: "idle" }
  | { readonly state: "connected" }
  | { readonly state: "unavailable"; readonly reason: string };

export interface BrowserLink {
  /** One op on the hub; rejects with the hub's / extension's message. */
  call(op: HubOp): Promise<unknown>;
  status(): BrowserLinkStatus;
  /** Hub events (`tab_closed`, `detached`, `chrome_closed`). */
  onEvent(listener: (event: HubEvent) => void): () => void;
  dispose(): void;
}

export interface BrowserLinkOptions {
  readonly configDir: string;
  /** This daemon's id: one per process. */
  readonly daemonId: string;
  /** The dial (tests inject; default a unix-socket connect). */
  readonly dial?: (path: string) => Socket;
  readonly connectTimeoutMs?: number;
}

interface Waiter {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
}

export function createBrowserLink(options: BrowserLinkOptions): BrowserLink {
  const sock = hubSocketPath(options.configDir);
  const dial = options.dial ?? ((p: string) => createConnection(p));
  let socket: Socket | undefined;
  let connecting: Promise<Socket> | undefined;
  let state: BrowserLinkStatus = { state: "idle" };
  let nextId = 1;
  let disposed = false;
  const waiters = new Map<number, Waiter>();
  const listeners = new Set<(event: HubEvent) => void>();

  const failAll = (message: string): void => {
    for (const w of waiters.values()) w.reject(new Error(message));
    waiters.clear();
  };

  function connect(): Promise<Socket> {
    if (socket !== undefined && !socket.destroyed) return Promise.resolve(socket);
    if (connecting !== undefined) return connecting;
    const attempt = new Promise<Socket>((resolve, reject) => {
      const s = dial(sock);
      let ready = false;
      const fail = (reason: string): void => {
        state = { state: "unavailable", reason };
        s.destroy();
        if (!ready) reject(new Error(reason));
        else failAll(reason);
      };
      const timer = setTimeout(() => fail(NO_EXTENSION_MESSAGE), options.connectTimeoutMs ?? 5000);
      const framer = new ByteFramer(
        {
          onLine: (line) => {
            let m: Record<string, unknown>;
            try {
              m = JSON.parse(line) as Record<string, unknown>;
            } catch {
              return fail("the browser hub sent a malformed frame");
            }
            if (!ready) {
              clearTimeout(timer);
              if (m.ok !== true) {
                return fail(typeof m.error === "string" ? m.error : "the browser hub refused us");
              }
              ready = true;
              socket = s;
              state = { state: "connected" };
              return resolve(s);
            }
            if (typeof m.id === "number") {
              const w = waiters.get(m.id);
              if (w === undefined) return;
              waiters.delete(m.id);
              if (m.ok === true) w.resolve(m.result);
              else w.reject(new Error(typeof m.error === "string" ? m.error : "failed"));
              return;
            }
            const ev = HubEvent.safeParse(m);
            if (ev.success) for (const l of listeners) l(ev.data);
          },
          onViolation: () => fail("the browser hub sent an oversized frame"),
        },
        HUB_MAX_LINE_BYTES,
      );
      s.on("data", (d) => framer.push(new Uint8Array(d)));
      s.on("error", () => {
        clearTimeout(timer);
        if (!ready) fail(NO_EXTENSION_MESSAGE);
      });
      s.on("close", () => {
        clearTimeout(timer);
        if (socket === s) socket = undefined;
        if (!ready) return fail(NO_EXTENSION_MESSAGE);
        failAll("the browser link closed");
        if (!disposed) state = { state: "idle" };
      });
      s.once("connect", () => {
        s.write(
          `${JSON.stringify({ version: BROWSER_LINK_VERSION, daemonId: options.daemonId })}\n`,
        );
      });
    });
    connecting = attempt.finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  return {
    async call(op) {
      if (disposed) throw new Error("the browser link is closed");
      const s = await connect();
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        s.write(`${JSON.stringify({ id, ...op })}\n`);
      });
    },
    status: () => state,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      failAll("the browser link is closed");
      socket?.destroy();
      socket = undefined;
    },
  };
}
