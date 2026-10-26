/**
 * `tentacle connect <url>` — launch the Ink TUI against a remote daemon.
 * The TUI is unchanged: it consumes a `RemoteSession` exactly like a local one,
 * and the same `PermissionBroker` carries approval prompts back over the wire.
 *
 * The link survives drops (docs/feat/client-reattach-frontends.md): the same
 * WebSocket factory opens the first channel and every redial, the session id
 * is ours (so even a drop during its first `open` is recovered), and the link
 * state shows in the StatusBar.
 */
import {
  ChannelError,
  type ConnectOptions as ClientConnectOptions,
  RemoteClient,
  type RemoteSession,
  type TlsOptions,
  webSocketChannelFactory,
} from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { MAX_SESSION_LIST } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { type SessionPick, oneLine, startTui } from "@tentacle/tui";
import {
  type ConnectResumeRequest,
  type ListOutcome,
  needsList,
  openError,
  planConnectResume,
  planPicked,
  shortId,
} from "./connect-resume.ts";
import { createHooksTrustResolver } from "./hooks-trust.ts";
import { CLIENT_INFO } from "./version.ts";

export interface ConnectOptions {
  readonly url: string;
  readonly token?: string;
  /** Trust a daemon whose cert is not in the system store (see `TlsOptions`). */
  readonly tls?: TlsOptions;
  /** `--resume [id]` / `--continue`: attach a daemon session instead of a new one. */
  readonly resume?: Omit<ConnectResumeRequest, "tty">;
}

/**
 * Collects the client's non-fatal peer errors (and startup warnings) while
 * Ink owns the terminal (a raw write mid-session corrupts the render,
 * AGENTS §7) and writes them, in order, once the TUI has exited.
 */
export function bufferedErrorSink(): {
  readonly onError: (error: Error) => void;
  readonly warning: (line: string) => void;
  readonly flush: (write: (line: string) => void) => void;
} {
  const lines: string[] = [];
  return {
    onError: (error) => {
      lines.push(`[connect] error: ${error.message}`);
    },
    warning: (line) => {
      lines.push(line);
    },
    flush: (write) => {
      for (const message of lines.splice(0)) {
        write(`${message}\n`);
      }
    },
  };
}

/**
 * The CLI's hint for a failed TLS handshake (close 1015,
 * docs/feat/client-tls-trust.md): the client names the failure, the CLI names
 * the flag. `undefined` when it is not a TLS failure or verification was
 * skipped (then the daemon most likely does not serve TLS — the message
 * already says so).
 */
export function tlsTrustHint(error: unknown, tls: TlsOptions | undefined): string | undefined {
  if (!(error instanceof ChannelError) || error.closeCode !== 1015) {
    return undefined;
  }
  if (tls?.rejectUnauthorized === false) {
    return undefined;
  }
  return tls?.ca !== undefined
    ? "check that --ca-cert is the CA that signed the daemon's certificate"
    : "to trust a self-signed or private-CA daemon, pass --ca-cert FILE (or --insecure-skip-tls-verify, dev-only)";
}

/** Injectable for tests; production uses the real socket and TUI. */
export interface ConnectDeps {
  /** A channel factory for the daemon at `url` (rejects with a `ChannelError`). */
  readonly dial: (url: string, options: ClientConnectOptions) => () => Promise<DuplexChannel>;
  readonly startTui: typeof startTui;
  /** The pre-mount `--resume` picker (a terminal only); absent → the newest resumes. */
  readonly pick?: SessionPick;
}

export async function connectTui(
  options: ConnectOptions,
  write: (line: string) => void,
  deps: ConnectDeps = { dial: webSocketChannelFactory, startTui },
): Promise<void> {
  // RPC path: hold a daemon's request until the TUI's prompt is mounted.
  const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
  const dial = deps.dial(options.url, {
    ...(options.token ? { token: options.token } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
  });
  // Before Ink mounts: a failure here (a bad token, nothing listening) is the
  // plain error the caller prints.
  let channel: DuplexChannel;
  try {
    channel = await dial();
  } catch (error) {
    const hint = tlsTrustHint(error, options.tls);
    if (hint !== undefined && error instanceof ChannelError) {
      throw new ChannelError(error.kind, `${error.message} — ${hint}`, error.closeCode);
    }
    throw error;
  }
  const sink = bufferedErrorSink();
  if (options.tls?.rejectUnauthorized === false) {
    // Dev-only, so it is surfaced — never silent (AGENTS §7: via the sink, not
    // a raw write while Ink owns the terminal).
    sink.warning(
      "[connect] warning: --insecure-skip-tls-verify skips TLS certificate verification (dev-only); the daemon's identity is not verified",
    );
  }
  const client = new RemoteClient(channel, permissions, undefined, {
    onError: sink.onError,
    channelFactory: dial,
    // Asked through the same broker; never stored (the folder is on another host).
    hooksTrust: createHooksTrustResolver({ broker: permissions, interactive: true }),
    clientInfo: CLIENT_INFO,
  });
  // Every controller handed to the TUI, by id: what the exit line reports on.
  const handed = new Map<string, RemoteSession>();
  const track = (session: RemoteSession): RemoteSession => {
    const id = session.sessionId;
    if (id !== null) handed.set(id, session);
    return session;
  };
  try {
    await client.initialize();
    // Before Ink mounts (AGENTS §7): the list, the picker, the eager attach.
    const first = await resumeFirst(client, options, deps, write);
    if (first === "cancelled") {
      return;
    }
    let pending = first;
    await deps.startTui(null, {
      model: "remote",
      cwd: options.url,
      permissions,
      // The resumed session first (already attached), then fresh lazy ones (a `/clear`).
      createSession: () => {
        const session = pending ?? client.newSession(undefined, crypto.randomUUID());
        pending = null;
        return track(session);
      },
      link: client,
      skills: () => client.skills(),
      mcpStatus: () => client.mcpStatus(),
      skillsList: () => client.skillsList(),
      detachOnQuit: true,
      sessions: {
        list: () =>
          client.sessionList({ limit: MAX_SESSION_LIST }).then((result) => ({
            sessions: result.sessions.map((s) => ({
              id: s.sessionId,
              title: s.title,
              updatedAt: s.updatedAt,
              running: s.running,
              attached: s.attached,
              archived: s.archived,
            })),
            more: result.cursor !== undefined,
          })),
        open: (id, reopen) =>
          track(client.newSession(undefined, id, undefined, { attach: reopen ? { reopen } : {} })),
        remove: (id) => client.deleteSession(id),
      },
    });
  } finally {
    // Quitting DETACHES (docs/feat/connect-sessions.md): the socket closes
    // with no `session/close`, so the session, a running turn (another
    // device's too) and its jobs go on daemon-side. Only what the user ended
    // (`/clear`, `/close`, a delete) is closed — awaited here, bounded, so a
    // close issued right before quitting still reaches the daemon.
    await client.drain();
    const left = client.liveSessionIds().map((id) => ({
      id,
      staying: handed.get(id)?.stayingRows() ?? 0,
    }));
    client.close();
    sink.flush(write);
    // After Ink unmounted (AGENTS §7): what was left running, and how to come back.
    for (const { id, staying } of left) {
      write(
        `[connect] left session ${shortId(id)} on the daemon — resume: tentacle connect ${oneLine(options.url)} --resume ${oneLine(id)}\n`,
      );
      if (staying > 0) {
        write(
          `[connect] ${staying} queued ${staying === 1 ? "message stays" : "messages stay"} on the daemon in session ${shortId(id)}\n`,
        );
      }
    }
  }
}

/**
 * The session the first view shows (`--resume` / `--continue`), resolved and
 * attached BEFORE Ink mounts: null → a fresh lazy session (no flag, or an
 * empty daemon); "cancelled" → the picker was dismissed (don't start). A gone
 * id fails here as a plain error — nothing is created (an attach never creates).
 */
async function resumeFirst(
  client: RemoteClient,
  options: ConnectOptions,
  deps: ConnectDeps,
  write: (line: string) => void,
): Promise<RemoteSession | null | "cancelled"> {
  if (!options.resume) {
    return null;
  }
  const request: ConnectResumeRequest = { ...options.resume, tty: deps.pick !== undefined };
  const list: ListOutcome | undefined = needsList(request)
    ? await client.sessionList({ limit: MAX_SESSION_LIST }).then(
        (result) => ({ ok: true, result }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
    : undefined;
  let plan = planConnectResume(request, list);
  if (plan.kind === "pick") {
    const id = deps.pick && list?.ok ? await deps.pick(plan.choices) : null;
    if (id === null || !list?.ok) {
      write("[resume] cancelled\n");
      return "cancelled";
    }
    plan = planPicked(list.result, id);
  }
  switch (plan.kind) {
    case "error":
      throw new Error(plan.message);
    case "pick":
      throw new Error("internal: the picker answered with another picker");
    case "new":
      if (plan.line) write(`${plan.line}\n`);
      return null;
    case "open": {
      const session = client.newSession(undefined, plan.id, undefined, {
        attach: plan.reopen ? { reopen: true } : {},
      });
      try {
        await session.open();
      } catch (error) {
        throw new Error(openError(plan.id, error));
      }
      if (plan.line) write(`${plan.line}\n`);
      return session;
    }
  }
}
