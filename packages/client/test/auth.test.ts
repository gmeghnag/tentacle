import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RemoteClient } from "../src/remote-client.ts";
import { connectWebSocket } from "../src/ws-channel.ts";

// Handshake-only: initialize never builds an agent, so the factory can throw.
const host = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

describe("token auth over a real socket", () => {
  test("a correct token connects and handshakes; a missing token is rejected", async () => {
    const server = startWsServer({ host: "127.0.0.1", port: 0, token: "good", sessionHost: host });
    try {
      // No token → rejected at the upgrade (401), so connect fails.
      await expect(connectWebSocket(server.url)).rejects.toThrow();

      // Correct token → connects and the handshake succeeds.
      const channel = await connectWebSocket(server.url, { token: "good" });
      const client = new RemoteClient(channel, new PermissionBroker());
      const init = await client.initialize();
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      client.close();
    } finally {
      server.stop();
    }
  });
});
