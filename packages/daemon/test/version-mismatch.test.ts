import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, VersionMismatchDataSchema } from "@tentacle/protocol";
import { DomainErrorCode, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";
import { versionMismatch } from "../src/version-mismatch.ts";

describe("versionMismatch (the daemon words the refusal)", () => {
  test("client older, both versions known: the owner's line", () => {
    const { message, data } = versionMismatch(
      { protocol: 10, tentacle: "0.1.0", name: "tentacle" },
      { protocol: 11, identity: { tentacle: "0.2.0", kind: "serve" } },
    );
    expect(message).toBe(
      'protocol version mismatch: client 10 (tentacle 0.1.0), daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"',
    );
    expect(data).toEqual({
      client: { protocol: 10, tentacle: "0.1.0" },
      daemon: { protocol: 11, tentacle: "0.2.0" },
      update: "client",
    });
  });

  test("daemon older, a `serve` daemon: the owner's line", () => {
    const { message, data } = versionMismatch(
      { protocol: 11, tentacle: "0.2.0", name: "tentacle" },
      { protocol: 10, identity: { tentacle: "0.1.0", kind: "serve" } },
    );
    expect(message).toBe(
      'protocol version mismatch: client 11 (tentacle 0.2.0), daemon 10 (tentacle 0.1.0) — update the daemon: run "tentacle update" on that host and restart "tentacle serve"',
    );
    expect(data.update).toBe("daemon");
  });

  test("an old client (no clientInfo): only what the daemon knows, advice still right", () => {
    const { message, data } = versionMismatch(
      { protocol: 10 },
      { protocol: 11, identity: { tentacle: "0.2.0", kind: "serve" } },
    );
    expect(message).toBe(
      'protocol version mismatch: client 10, daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"',
    );
    expect(data.client).toEqual({ protocol: 10 });
  });

  test("a container daemon older: run attach again (never `serve`)", () => {
    const { message } = versionMismatch(
      { protocol: 11, tentacle: "0.2.0", name: "tentacle" },
      { protocol: 10, identity: { tentacle: "0.1.0", kind: "container" } },
    );
    expect(message).toBe(
      'protocol version mismatch: client 11 (tentacle 0.2.0), daemon 10 (tentacle 0.1.0) — update the container\'s tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)',
    );
    expect(message).not.toContain("pod");
  });

  test("a client that is not the CLI gets no CLI command", () => {
    const { message } = versionMismatch(
      { protocol: 10, tentacle: "1.0.0", name: "tentacle-mobile" },
      { protocol: 11 },
    );
    expect(message).toBe(
      "protocol version mismatch: client 10 (tentacle-mobile 1.0.0), daemon 11 — update this client",
    );
  });

  test("no daemon identity (tests): the daemon side says only its protocol", () => {
    const { message, data } = versionMismatch({ protocol: 9 }, { protocol: 10 });
    expect(message).toBe(
      'protocol version mismatch: client 9, daemon 10 — update this client: "tentacle update"',
    );
    expect(data.daemon).toEqual({ protocol: 10 });
  });
});

describe("Connection refuses initialize with the worded message and its data", () => {
  async function refuse(
    params: Record<string, unknown>,
    identity?: ConstructorParameters<typeof SessionHost>[0]["identity"],
  ) {
    const host = new SessionHost({
      defaultCwd: "/tmp/daemon-work",
      createAgent: () => {
        throw new Error("unused");
      },
      ...(identity ? { identity } : {}),
    });
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, host);
    const client = new RpcPeer(clientCh, { onRequest: () => null, onNotification: () => {} });
    return client.request("initialize", params).then(
      () => {
        throw new Error("initialize succeeded");
      },
      (error: { code: number; message: string; data?: unknown }) => error,
    );
  }

  // The invariant the client's "the daemon is older" deduction rests on: EVERY
  // VersionMismatch from this daemon on carries a valid `data`.
  for (const [label, params] of [
    ["older client", { protocolVersion: PROTOCOL_VERSION - 1, clientCapabilities: {} }],
    ["newer client", { protocolVersion: PROTOCOL_VERSION + 1, clientCapabilities: {} }],
    [
      "malformed clientInfo",
      {
        protocolVersion: PROTOCOL_VERSION + 1,
        clientCapabilities: {},
        clientInfo: { name: "tentacle", version: "\u001b[2J" },
      },
    ],
  ] as const) {
    test(`every refusal carries a valid data (${label})`, async () => {
      const error = await refuse(params);
      expect(error.code).toBe(DomainErrorCode.VersionMismatch);
      expect(VersionMismatchDataSchema.safeParse(error.data).success).toBe(true);
      expect(error.message).not.toContain("\u001b");
    });
  }

  test("the host's identity and the client's clientInfo reach the message", async () => {
    const error = await refuse(
      {
        protocolVersion: PROTOCOL_VERSION + 1,
        clientCapabilities: {},
        clientInfo: { name: "tentacle", version: "9.0.0" },
      },
      { tentacle: "0.1.0", kind: "container" },
    );
    expect(error.message).toBe(
      `protocol version mismatch: client ${PROTOCOL_VERSION + 1} (tentacle 9.0.0), daemon ${PROTOCOL_VERSION} (tentacle 0.1.0) — update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)`,
    );
    expect(error.data).toEqual({
      client: { protocol: PROTOCOL_VERSION + 1, tentacle: "9.0.0" },
      daemon: { protocol: PROTOCOL_VERSION, tentacle: "0.1.0" },
      update: "daemon",
    });
  });
});
