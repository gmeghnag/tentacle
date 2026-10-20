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
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { DuplexChannel } from "@tentacle/transport";
import { startTui } from "@tentacle/tui";

export interface ConnectOptions {
  readonly url: string;
  readonly token?: string;
}

/**
 * Collects the client's non-fatal peer errors while Ink owns the terminal
 * (a raw write mid-session corrupts the render, AGENTS §7) and writes them,
 * in order, once the TUI has exited.
 */
export function bufferedErrorSink(): {
  readonly onError: (error: Error) => void;
  readonly flush: (write: (line: string) => void) => void;
} {
  const errors: string[] = [];
  return {
    onError: (error) => {
      errors.push(error.message);
    },
    flush: (write) => {
      for (const message of errors.splice(0)) {
        write(`[connect] error: ${message}\n`);
      }
    },
  };
}

/** Injectable for tests; production uses the real socket and TUI. */
export interface ConnectDeps {
  /** A channel factory for the daemon at `url` (rejects with a `ChannelError`). */
  readonly dial: (url: string, options: { token?: string }) => () => Promise<DuplexChannel>;
  readonly startTui: typeof startTui;
}

export async function connectTui(
  options: ConnectOptions,
  write: (line: string) => void,
  deps: ConnectDeps = { dial: webSocketChannelFactory, startTui },
): Promise<void> {
  // RPC path: hold a daemon's request until the TUI's prompt is mounted.
  const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
  const dial = deps.dial(options.url, options.token ? { token: options.token } : {});
  // Before Ink mounts: a failure here (a bad token, nothing listening) is the
  // plain error the caller prints.
  const channel = await dial();
  const sink = bufferedErrorSink();
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
    });
  } finally {
    // The daemon keeps sessions past a disconnect: quitting ends ours (turn +
    // background jobs), acknowledged before the socket closes.
    await client.closeSessions();
    client.close();
    sink.flush(write);
  }
}
