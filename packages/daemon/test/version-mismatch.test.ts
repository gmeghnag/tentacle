import { describe, expect, test } from "bun:test";
import {
  InitializeParamsSchema,
  PROTOCOL_VERSION,
  VersionMismatchDataSchema,
} from "@tentacle/protocol";
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

  test("15 ↔ 16 (config-carry's bump): a resident pod daemon of the old build is refused cleanly at initialize", async () => {
    // A laptop on protocol 15 bridged to a 16 resident (or the reverse) must
    // fail here: a 15 daemon strips `session/open.settings`, and a 16 laptop no
    // longer passes the flags (docs/feat/config-carry.md; 14 ↔ 15 was
    // parallel-tools' `tool_call_phase`).
    const error = await refuse(
      {
        protocolVersion: 15,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.3.0" },
      },
      { tentacle: "0.4.0", kind: "container" },
    );
    expect(error.code).toBe(DomainErrorCode.VersionMismatch);
    expect(error.data).toMatchObject({
      client: { protocol: 15, tentacle: "0.3.0" },
      daemon: { protocol: PROTOCOL_VERSION, tentacle: "0.4.0" },
    });
  });

  test("16 ↔ 17 (session-log's bump): a resident pod daemon of the old build is refused cleanly at initialize", async () => {
    // A 16 daemon has no `session/log` (a 17 laptop persists only through it,
    // no snapshot fallback); a 17 daemon serves a 16 laptop's snapshot reads
    // but the pair must not mix (docs/feat/session-log.md, Q2).
    const error = await refuse(
      {
        protocolVersion: 16,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.4.0" },
      },
      { tentacle: "0.5.0", kind: "container" },
    );
    expect(error.code).toBe(DomainErrorCode.VersionMismatch);
    expect(error.data).toMatchObject({
      client: { protocol: 16, tentacle: "0.4.0" },
      daemon: { protocol: PROTOCOL_VERSION, tentacle: "0.5.0" },
    });
  });

  test("17 ↔ 18 (models-map's bump: `model/slots` removed): an old pod daemon is refused cleanly at initialize", async () => {
    // A 17 pod daemon would ask the laptop `model/slots` mid-turn and get
    // MethodNotFound; the pair must fail here instead (docs/feat/models-map.md).
    const error = await refuse(
      {
        protocolVersion: 17,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.5.0" },
      },
      { tentacle: "0.6.0", kind: "container" },
    );
    expect(error.code).toBe(DomainErrorCode.VersionMismatch);
    expect(error.data).toMatchObject({
      client: { protocol: 17, tentacle: "0.5.0" },
      daemon: { protocol: PROTOCOL_VERSION, tentacle: "0.6.0" },
    });
  });

  test("18 ↔ 19 (models-map-pod's bump): a pod daemon or a laptop on 18 is refused at initialize, worded", async () => {
    // A laptop on 18 would strip the name and serve a named call with its MAIN
    // model, silently (docs/feat/models-map-pod.md): the pair must fail here.
    const older = await refuse(
      {
        protocolVersion: 18,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.6.0" },
      },
      { tentacle: "0.7.0", kind: "container" },
    );
    expect(older.code).toBe(DomainErrorCode.VersionMismatch);
    expect(older.message).toContain(
      `client 18 (tentacle 0.6.0), daemon ${PROTOCOL_VERSION} (tentacle 0.7.0)`,
    );
    expect(older.data).toMatchObject({ update: "client" });
    // The daemon compares for inequality, so a client AHEAD of it is refused too.
    const newer = await refuse(
      {
        protocolVersion: PROTOCOL_VERSION + 1,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.8.0" },
      },
      { tentacle: "0.7.0", kind: "container" },
    );
    expect(newer.code).toBe(DomainErrorCode.VersionMismatch);
    expect(newer.message).toContain(
      `client ${PROTOCOL_VERSION + 1} (tentacle 0.8.0), daemon ${PROTOCOL_VERSION} (tentacle 0.7.0)`,
    );
  });

  test("10 ↔ current (session-archive's bump, context-reset's, skills-hot-reload's, detached-runs', parallel-tools', config-carry's, session-log's, then models-map's, models-map-pod's, subagent-background's, then clear-keeps-jobs', then autoaccept-wake-turns'): a 0.1.0 client is told to update, worded by THIS daemon", async () => {
    // What a tentacle 0.1.0 sends (protocol 10, clientInfo since version-mismatch-notice).
    expect(PROTOCOL_VERSION as number).toBe(22);
    const error = await refuse(
      {
        protocolVersion: 10,
        clientCapabilities: { streaming: true },
        clientInfo: { name: "tentacle", version: "0.1.0" },
      },
      { tentacle: "0.2.0", kind: "serve" },
    );
    expect(error.code).toBe(DomainErrorCode.VersionMismatch);
    expect(error.message).toBe(
      'protocol version mismatch: client 10 (tentacle 0.1.0), daemon 22 (tentacle 0.2.0) — update this client: "tentacle update"',
    );
    expect(error.data).toEqual({
      client: { protocol: 10, tentacle: "0.1.0" },
      daemon: { protocol: 22, tentacle: "0.2.0" },
      update: "client",
    });
  });

  test("11 → a v10 daemon: the v11 initialize frame is one a v10 daemon parses (no InvalidParams), so it words the refusal", () => {
    // InitializeParamsSchema is unchanged by the bump (a v10 daemon validates with the same
    // schema): the frame a v11 client sends must parse, extras stripped, or the user would get
    // InvalidParams instead of the mismatch message (version-mismatch-notice constraint).
    const frame = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, updates: ["agent_message_chunk"] },
      clientInfo: { name: "tentacle", version: "0.2.0" },
    };
    expect(InitializeParamsSchema.safeParse(frame).success).toBe(true);
    // And the v10 daemon's wording for it (`versionMismatch` is unchanged since v10).
    expect(
      versionMismatch(
        { protocol: PROTOCOL_VERSION, tentacle: "0.2.0", name: "tentacle" },
        { protocol: 10, identity: { tentacle: "0.1.0", kind: "serve" } },
      ).data.update,
    ).toBe("daemon");
  });

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
