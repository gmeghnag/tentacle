/**
 * `agent-harness connect <url>` — launch the Ink TUI against a remote daemon.
 * The TUI is unchanged: it consumes a `RemoteSession` exactly like a local one,
 * and the same `PermissionBroker` carries approval prompts back over the wire.
 */
import { RemoteClient, connectWebSocket } from "@agent-harness/client";
import { PermissionBroker } from "@agent-harness/core";
import { startTui } from "@agent-harness/tui";

export interface ConnectOptions {
  readonly url: string;
  readonly token?: string;
}

export async function connectTui(options: ConnectOptions): Promise<void> {
  const permissions = new PermissionBroker();
  const channel = await connectWebSocket(
    options.url,
    options.token ? { token: options.token } : {},
  );
  const client = new RemoteClient(channel, permissions);
  await client.initialize();
  try {
    await startTui(null, {
      model: "remote",
      cwd: options.url,
      permissions,
      createSession: () => client.newSession(),
    });
  } finally {
    client.close();
  }
}
