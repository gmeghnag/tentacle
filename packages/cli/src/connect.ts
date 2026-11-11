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
import { readFileConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import { MAX_SESSION_LIST } from "@tentacle/protocol";
import type { InitializeResult } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { type SessionPick, type ThemeSetting, oneLine, startTui } from "@tentacle/tui";
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
import { remoteJobsView } from "./local-runtime.ts";
import { CLIENT_INFO } from "./version.ts";

export interface ConnectOptions {
  readonly url: string;
  readonly token?: string;
  /** Trust a daemon whose cert is not in the system store (see `TlsOptions`). */
  readonly tls?: TlsOptions;
  /** `--resume [id]` / `--continue`: attach a daemon session instead of a new one. */
  readonly resume?: Omit<ConnectResumeRequest, "tty">;
  /** Where the palette is configured (`tui.theme`); `TENTACLE_CONFIG_DIR` by default. */
  readonly configDir?: string;
  /** An explicit `tui.theme` (beats the file); absent → the file's, else `auto`. */
  readonly theme?: ThemeSetting;
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

/**
 * The palette for a `connect` session (docs/feat/tui-light-theme.md S5).
 *
 * `connect` needs no model configuration — it reaches a daemon that has one — so
 * the palette comes from the config FILE alone, through `readFileConfig` (the same
 * parser `loadConfig` uses). An invalid file must never block the connection: a
 * typo in `tui.theme` would otherwise refuse to connect at all. One line names the
 * problem and `auto` is used.
 */
export async function connectTheme(
  options: ConnectOptions,
  write: (line: string) => void,
): Promise<ThemeSetting> {
  if (options.theme !== undefined) {
    return options.theme;
  }
  try {
    const file = await readFileConfig({
      ...(options.configDir !== undefined
        ? {
            configDir: options.configDir,
            env: { ...process.env, TENTACLE_CONFIG_DIR: options.configDir },
          }
        : {}),
    });
    return file.tui?.theme ?? "auto";
  } catch (error) {
    write(
      `[config] ${error instanceof Error ? error.message : String(error)} — using tui.theme auto\n`,
    );
    return "auto";
  }
}

/** Injectable for tests; production uses the real socket and TUI. */
export interface ConnectDeps {
  /** A channel factory for the daemon at `url` (rejects with a `ChannelError`). */
  readonly dial: (url: string, options: ClientConnectOptions) => () => Promise<DuplexChannel>;
  readonly startTui: typeof startTui;
  /**
   * The pre-mount `--resume` picker (a terminal only); absent → the newest resumes.
   * `options.theme` is the palette `connectTheme` settled — the picker must paint
   * the same one the TUI that follows will (a caller cannot supply it earlier: the
   * setting comes from the config FILE, which only `connectTui` reads).
   */
  readonly pick?: SessionPick;
}

export async function connectTui(
  options: ConnectOptions,
  write: (line: string) => void,
  deps: ConnectDeps = { dial: webSocketChannelFactory, startTui },
): Promise<void> {
  // The palette FIRST: it needs no daemon (a local file), Ink has not mounted, and
  // a broken config must warn before anything else can fail for another reason.
  const theme = await connectTheme(options, write);
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
    // The ONE place this trust bit is set (AGENTS §7, docs/fix/autoaccept-wake-turns.md
    // A3): a `serve` daemon is trusted and is the only one that starts its own
    // wake turns, so its `wake-…` asks are this session's — auto-accept answers
    // them. Every other runtime leaves it off: a pod's `wake-` id stays foreign.
    daemonWakes: true,
  });
  // Every controller handed to the TUI, by id: what the exit line reports on.
  const handed = new Map<string, RemoteSession>();
  const track = (session: RemoteSession): RemoteSession => {
    const id = session.sessionId;
    if (id !== null) handed.set(id, session);
    return session;
  };
  try {
    const handshake = await client.initialize();
    // Before Ink mounts (AGENTS §7): the list, the picker, the eager attach. The
    // picker is handed the palette `connectTheme` settled (HIGH 2: the caller
    // CANNOT know it — `connect` loads no config — and a closure over its own
    // `config` was read before that `let` existed).
    const first = await resumeFirst(
      client,
      options,
      deps.pick === undefined
        ? deps
        : {
            ...deps,
            pick: (choices) => (deps.pick as SessionPick)(choices, { theme }),
          },
      write,
    );
    if (first === "cancelled") {
      return;
    }
    let pending = first;
    // What the daemon says about ITS OWN model (round 2): the ctx meter must
    // draw the daemon's window, not this laptop's, and the input rule must name
    // that model instead of `remote`. Absent (an older daemon, a pod) → nothing
    // is passed and the TUI keeps its own defaults.
    const served = servedModel(handshake);
    await deps.startTui(null, {
      // `remote` still means "the model is the daemon's" for every SEMANTIC use
      // (the error hint, docs/fix/…(c)); `modelLabel` is what is PAINTED.
      model: "remote",
      ...(served.label !== undefined ? { modelLabel: served.label } : {}),
      ...(served.contextWindow !== undefined ? { contextWindow: served.contextWindow } : {}),
      cwd: options.url,
      permissions,
      // The resumed session first (already attached), then fresh lazy ones (a `/clear`).
      createSession: () => {
        const session = pending ?? client.newSession(undefined, crypto.randomUUID());
        pending = null;
        return track(session);
      },
      jobs: remoteJobsView(client),
      // The TUI's ONE live job exit feed (`docs/fix/connect-functest-batch.md`
      // item A): without it the drawer's outcome/`endedAt` handler never fires
      // and a finished job freezes on the `✗ stopped` fallback, its clock
      // counting. The SAME view every RPC runtime uses (`remoteJobsView`).
      // …and `connect` NEVER wakes: the `serve` daemon owns that, per ITS OWN
      // host's `autoWake` (docs/feat/serve-autowake.md — it wakes a session
      // nobody is attached to, and a `connect` TUI attached to it, too). The exit
      // feed above is for the DRAWER's outcome, not for a turn: with the App's
      // default on, this TUI would start a second continuation (and would
      // override a `serve` host that set `autoWake: false`).
      autoWakeOnJobExit: false,
      link: client,
      mcpStatus: () => client.mcpStatus(),
      detachOnQuit: true,
      theme,
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
 * What a `connect` TUI may learn from `initialize` about the daemon's OWN model
 * (docs/fix/connect-model-error-drops-connection.md round 2).
 *
 * A daemon is a peer, not to be trusted with the terminal (AGENTS §7): the name
 * is made one line and capped HERE, before it can reach the ink tree — and its
 * TYPE is checked HERE too, because this is the only gate: the client casts the
 * handshake instead of parsing it with the wire schema (`remote-client.ts`), so
 * a daemon of another build (or one sending a number or an object) must be
 * ignored, never throw over a display-only fact. `label` is absent when the
 * daemon reported no model (an older daemon, a pod, whose model is the laptop's)
 * — and `contextWindow` is dropped with it: a window with no name is not a fact
 * we can attribute.
 */
export function servedModel(handshake: InitializeResult): {
  readonly label?: string;
  readonly contextWindow?: number;
} {
  const info = handshake.agentInfo;
  const raw: unknown = info?.model;
  const name = typeof raw === "string" ? oneLine(raw).slice(0, MODEL_LABEL_MAX) : "";
  if (name === "") {
    return {};
  }
  const window: unknown = info?.contextWindow;
  return {
    label: name,
    ...(typeof window === "number" && Number.isInteger(window) && window > 0
      ? { contextWindow: window }
      : {}),
  };
}

/** A model name's cap on the input rule (a real id like `rits/deepseek-ai/DeepSeek-V4.1` fits). */
export const MODEL_LABEL_MAX = 64;

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
      return "cancelled"; // Esc / Ctrl+C: exit silently
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
