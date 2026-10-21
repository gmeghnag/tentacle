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
  type TlsOptions,
  webSocketChannelFactory,
} from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { DuplexChannel } from "@tentacle/transport";
import { startTui } from "@tentacle/tui";

export interface ConnectOptions {
  readonly url: string;
  readonly token?: string;
  /** Trust a daemon whose cert is not in the system store (see `TlsOptions`). */
  readonly tls?: TlsOptions;
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
  });
  try {
    await client.initialize();
    await deps.startTui(null, {
      model: "remote",
      cwd: options.url,
      permissions,
      createSession: () => client.newSession(undefined, crypto.randomUUID()),
      link: client,
      skills: () => client.skills(),
      mcpStatus: () => client.mcpStatus(),
    });
  } finally {
    // The daemon keeps sessions past a disconnect: quitting ends ours (turn +
    // background jobs), acknowledged before the socket closes.
    await client.closeSessions();
    client.close();
    sink.flush(write);
  }
}
