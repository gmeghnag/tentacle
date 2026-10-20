/**
 * The WebSocket channel factory over REAL sockets (docs/feat/client-reattach-frontends.md):
 * a rejected upgrade is classified (Q8: Bun shows every non-101 as close 1002,
 * a GET probe tells 401 from the rest), and `connect`'s client re-attaches to a
 * `serve` daemon that went away mid-turn and came back.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { ChannelError, type LinkStatus } from "../src/link-machine.ts";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { classifyUpgradeFailure, webSocketChannelFactory } from "../src/ws-channel.ts";
import { GatedModel, done, t, until } from "./support/fakes.ts";

async function dialError(dial: () => Promise<unknown>): Promise<ChannelError> {
  try {
    await dial();
  } catch (error) {
    if (error instanceof ChannelError) return error;
    throw new Error(`not a ChannelError: ${String(error)}`);
  }
  throw new Error("the dial succeeded");
}

describe("classifyUpgradeFailure (pure)", () => {
  test("1002 + a 401 probe is unauthorized; any other probe answer is rejected; the rest is unreachable", () => {
    expect(classifyUpgradeFailure(1002, 401).kind).toBe("unauthorized");
    expect(classifyUpgradeFailure(1002, 426).kind).toBe("rejected");
    expect(classifyUpgradeFailure(1002, 502).message).toContain("HTTP 502");
    // The probe itself failed: never terminal on a guess.
    expect(classifyUpgradeFailure(1002, null).kind).toBe("rejected");
    expect(classifyUpgradeFailure(1006, null).kind).toBe("unreachable");
    expect(classifyUpgradeFailure(1001, null).kind).toBe("unreachable");
  });
});

describe("webSocketChannelFactory over a real socket", () => {
  test("bad token → unauthorized, a 502 → rejected, a closed port → unreachable, good token → a channel", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization");
        if (url.searchParams.get("token") !== "good" || auth !== "Bearer good") {
          return new Response("unauthorized", { status: 401 });
        }
        if (url.pathname === "/502") return new Response("bad gateway", { status: 502 });
        return srv.upgrade(req) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: { message() {} },
    });
    const base = `ws://127.0.0.1:${server.port}`;
    try {
      expect((await dialError(webSocketChannelFactory(base, { token: "bad" }))).kind).toBe(
        "unauthorized",
      );
      expect(
        (await dialError(webSocketChannelFactory(`${base}/502`, { token: "good" }))).kind,
      ).toBe("rejected");
      expect((await dialError(webSocketChannelFactory("ws://127.0.0.1:1"))).kind).toBe(
        "unreachable",
      );
      const channel = await webSocketChannelFactory(base, { token: "good" })();
      channel.close();
    } finally {
      server.stop(true);
    }
  });
});

describe("connect's client re-attaches over a real WebSocket", () => {
  test("the daemon goes away mid-turn and comes back: the turn completes, status reconnecting → up", async () => {
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry(),
          env: {
            id: "e",
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            readFile: async () => "",
            writeFile: async () => {},
          },
          requestPermission: (r, o) => permissions.request(r, o),
        });
        return { agent, permissions };
      },
    });
    let server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: host, token: "good" });
    const port = server.port;
    const factory = webSocketChannelFactory(server.url, { token: "good" });
    const client = new RemoteClient(await factory(), new PermissionBroker(), undefined, {
      channelFactory: factory,
      random: () => 0, // retry at once
    });
    const statuses: LinkStatus["state"][] = [];
    client.onLinkStatus((s) => statuses.push(s.state));
    try {
      await client.initialize();
      const session = client.newSession(undefined, crypto.randomUUID());
      const events: SessionEvent[] = [];
      const turn = (async () => {
        for await (const e of session.send("hi")) events.push(e);
      })();
      expect(await until(() => model.waiting)).toBe(true);
      server.stop();
      expect(await until(() => statuses.includes("reconnecting"))).toBe(true);
      server = startWsServer({ host: "127.0.0.1", port, sessionHost: host, token: "good" });
      expect(await until(() => statuses.at(-1) === "up", 5000)).toBe(true);
      model.open();
      await turn;
      const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
      expect(text).toBe("ab");
      expect(events.at(-1)?.type).toBe("turn_end");
      expect(model.calls).toBe(1);
    } finally {
      await client.closeSessions();
      client.close();
      server.stop();
    }
  });
});
