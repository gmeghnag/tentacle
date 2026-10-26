/**
 * `session/skills` (docs/feat/skills-hot-reload.md, skills-panel.md) over real
 * daemon objects — and the client's guards against a hostile daemon (a pod:
 * untrusted strings) and a dropped link.
 */
import { describe, expect, test } from "bun:test";
import type { SkillListing } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

function hostWith(listing?: SkillListing): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/skills-list-client",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(listing ? { newSessionSkills: async () => listing } : {}),
  });
}

function connected(host: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  return new RemoteClient(c, new PermissionBroker());
}

/** A raw daemon: answers `initialize`, then `reply()` to anything else. */
function rawDaemon(reply: () => Record<string, unknown>): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string };
    if (frame.id === undefined) {
      return;
    }
    const body =
      frame.method === "initialize"
        ? {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            },
          }
        : reply();
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

const review = {
  name: "review",
  description: "review a diff",
  scope: "project" as const,
  user: true,
  model: false,
  location: "/w/.agents/skills/review/SKILL.md",
};

describe("session/skills from the client", () => {
  test("round-trips the daemon's listing, sanitised once by the host", async () => {
    const client = connected(
      hostWith({ skills: [review, { ...review, name: "x\u0007y" }], problems: ["p\nq"] }),
    );
    await client.initialize();
    expect(await client.sessionSkills()).toEqual({
      slash: [{ name: "review", description: "review a diff" }],
      skills: [review, { ...review, name: "x y" }],
      problems: ["p q"],
      moreProblems: 0,
    });
    client.close();
  });

  test("a daemon with no source answers an empty one", async () => {
    const client = connected(hostWith());
    await client.initialize();
    expect(await client.sessionSkills()).toEqual({
      slash: [],
      skills: [],
      problems: [],
      moreProblems: 0,
    });
    client.close();
  });

  test("a daemon that refuses the method: the rejection reaches the caller", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({ error: { code: JsonRpcErrorCode.MethodNotFound, message: "nope" } })),
      new PermissionBroker(),
    );
    await client.initialize();
    const error = await client.sessionSkills().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    client.close();
  });

  test("a hostile daemon's escape in a description (listing or /name list) is rejected whole", async () => {
    const result = (description: string, slashDescription = "fine") => ({
      result: {
        slash: [{ name: "review", description: slashDescription }],
        skills: [{ ...review, description }],
        problems: [],
        moreProblems: 0,
      },
    });
    for (const [listed, slash] of [
      ["pwn\u001b]52;c;AAAA\u0007", "fine"],
      ["fine", "pwn\u001b[2J"],
    ] as const) {
      const bad = new RemoteClient(
        rawDaemon(() => result(listed, slash)),
        new PermissionBroker(),
      );
      await bad.initialize();
      await expect(bad.sessionSkills()).rejects.toThrow();
      bad.close();
    }
    const good = new RemoteClient(
      rawDaemon(() => result("fine")),
      new PermissionBroker(),
    );
    await good.initialize();
    expect((await good.sessionSkills()).skills[0]?.description).toBe("fine");
    good.close();
  });

  test("link down (reconnecting): rejects at once, nothing sent", async () => {
    const [d, c] = createChannelPair();
    new Connection(d, hostWith());
    const sent: string[] = [];
    const tapped: DuplexChannel = {
      send: (data) => {
        sent.push(data);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    const client = new RemoteClient(tapped, new PermissionBroker(), undefined, {
      channelFactory: () => new Promise<DuplexChannel>(() => {}),
    });
    await client.initialize();
    d.close();
    await Bun.sleep(5);
    const before = sent.length;
    await expect(client.sessionSkills()).rejects.toThrow("not connected");
    expect(sent.length).toBe(before);
    client.close();
  });
});
