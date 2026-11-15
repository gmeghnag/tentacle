/**
 * `RemoteClient.daemonInfo()` (docs/feat/mobile-session-info.md slice 2): the
 * daemon's own build, model and context window from the LAST handshake, so a
 * phone that stays on screen after a `serve` restarted with another model shows
 * the model that is running now (F7) — not the one it paired with.
 *
 * A raw channel plays the daemon, so the handshake can be made to answer twice
 * with different facts (the fake channel factory's reconnect).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

interface AgentInfo {
  readonly version: string;
  readonly model?: string;
  readonly contextWindow?: number;
}

/**
 * A daemon that answers `initialize` with `info()` — re-read on EVERY handshake,
 * so a test can change what the daemon says between two of them.
 */
function daemon(info: () => AgentInfo): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string };
    if (frame.id === undefined || frame.method !== "initialize") {
      return;
    }
    d.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
          agentInfo: info(),
        },
      }),
    );
  });
  return c;
}

describe("daemonInfo", () => {
  test("before any handshake it reports nothing", () => {
    const client = new RemoteClient(
      daemon(() => ({ version: "1.0.0" })),
      new PermissionBroker(),
    );
    expect(client.daemonInfo()).toBeUndefined();
    client.close();
  });

  test("it carries the daemon's version, model and context window", async () => {
    const client = new RemoteClient(
      daemon(() => ({ version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 })),
      new PermissionBroker(),
    );
    await client.initialize();
    expect(client.daemonInfo()).toEqual({
      version: "1.4.0",
      model: "claude-sonnet-4-5",
      contextWindow: 200_000,
    });
    client.close();
  });

  test("an older daemon reports a version alone (no model, no window → absent, never 0)", async () => {
    const client = new RemoteClient(
      daemon(() => ({ version: "0.9.0" })),
      new PermissionBroker(),
    );
    await client.initialize();
    expect(client.daemonInfo()).toEqual({ version: "0.9.0" });
    client.close();
  });

  test("it follows the SECOND handshake (a `serve` restarted with another model — F7)", async () => {
    let info: AgentInfo = { version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 };
    const dial = (): DuplexChannel => daemon(() => info);
    let last: DuplexChannel | null = null;
    const first = dial();
    last = first;
    const client = new RemoteClient(first, new PermissionBroker(), undefined, {
      // The redial hands back a fresh channel: the daemon is asked AGAIN.
      channelFactory: async () => {
        const channel = dial();
        last = channel;
        return channel;
      },
      random: () => 0,
    });
    await client.initialize();
    expect(client.daemonInfo()?.model).toBe("claude-sonnet-4-5");
    // The daemon is replaced by one running another model (a `serve` restart).
    info = { version: "1.4.0", model: "qwen3-27b", contextWindow: 32_768 };
    first.close();
    const until = async (ready: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !ready(); i += 1) {
        await Bun.sleep(5);
      }
    };
    await until(() => client.daemonInfo()?.model === "qwen3-27b");
    expect(client.daemonInfo()).toEqual({
      version: "1.4.0",
      model: "qwen3-27b",
      contextWindow: 32_768,
    });
    void last;
    client.close();
  });
});
