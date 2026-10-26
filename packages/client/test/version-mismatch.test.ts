/**
 * A protocol skew, as the client sees it (docs/feat/version-mismatch-notice.md):
 * the daemon's own words when it reports its versions, the old-daemon advice
 * when it does not — decided from the error code and the report's presence,
 * never from the text.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { versionMismatch } from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import {
  DomainErrorCode,
  type DuplexChannel,
  RpcError,
  RpcPeer,
  createChannelPair,
} from "@tentacle/transport";
import type { LinkStatus } from "../src/link-machine.ts";
import { RemoteClient } from "../src/remote-client.ts";
import {
  OLD_DAEMON_ADVICE,
  explainVersionMismatch,
  oldDaemonAdvice,
} from "../src/version-mismatch.ts";
import { until } from "./support/fakes.ts";

/** A daemon that answers `initialize` with `answer` (a result, or a thrown error); records its params. */
function fakeDaemon(answer: () => unknown) {
  const seen: unknown[] = [];
  const connect = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new RpcPeer(d, {
      onRequest: (method, params) => {
        if (method === "initialize") {
          seen.push(params);
          return answer();
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
      onNotification: () => {},
    });
    return c;
  };
  return { seen, connect };
}

const OK = { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
const OLD_DAEMON_LINE = `protocol version mismatch: client ${PROTOCOL_VERSION}, daemon ${PROTOCOL_VERSION - 1}`;

describe("explainVersionMismatch", () => {
  test("a reported mismatch is the daemon's message, unchanged", () => {
    const { message, data } = versionMismatch({ protocol: 10 }, { protocol: 11 });
    const error = new RpcError(DomainErrorCode.VersionMismatch, message, data);
    expect(explainVersionMismatch(error)).toBe(error);
  });

  test("no report (a daemon older than it): the old-daemon advice is appended", () => {
    const error = new RpcError(DomainErrorCode.VersionMismatch, OLD_DAEMON_LINE);
    const explained = explainVersionMismatch(error);
    expect(explained?.message).toBe(
      `${OLD_DAEMON_LINE} — the daemon runs an older tentacle (it does not report its version): update the daemon: run "tentacle update" on that host and restart "tentacle serve"`,
    );
    expect((explained as RpcError).code).toBe(DomainErrorCode.VersionMismatch);
  });

  test("a report today's schema does not read (a later daemon) is still the daemon's own words", () => {
    // Its presence alone says the daemon postdates the report: never blame it as older.
    for (const data of [{ update: "both" }, { client: 1 }, "later", 0, null]) {
      const error = new RpcError(DomainErrorCode.VersionMismatch, "x", data);
      expect(explainVersionMismatch(error)).toBe(error);
    }
  });

  test("no report from a container daemon: the container advice, never `serve`", () => {
    const error = new RpcError(DomainErrorCode.VersionMismatch, OLD_DAEMON_LINE);
    const explained = explainVersionMismatch(error, "container");
    expect(explained?.message).toBe(
      `${OLD_DAEMON_LINE} — the daemon runs an older tentacle (it does not report its version): update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)`,
    );
    expect(explained?.message).not.toContain("serve");
    expect(oldDaemonAdvice("serve")).toBe(OLD_DAEMON_ADVICE);
  });

  test("any other error is not a mismatch", () => {
    expect(explainVersionMismatch(new RpcError(DomainErrorCode.Unauthorized, "no"))).toBeNull();
    expect(explainVersionMismatch(new Error("protocol version mismatch"))).toBeNull();
    expect(explainVersionMismatch(undefined)).toBeNull();
  });
});

describe("RemoteClient: who it is, and a skew at start and on reconnect", () => {
  test("initialize carries clientInfo when the runtime gives it", async () => {
    const daemon = fakeDaemon(() => OK);
    const info = { name: "tentacle", version: "0.2.0" };
    const client = new RemoteClient(daemon.connect(), new PermissionBroker(), undefined, {
      clientInfo: info,
    });
    await client.initialize();
    expect(daemon.seen).toEqual([expect.objectContaining({ clientInfo: info })]);
    client.close();
  });

  test("start, an old daemon (no report): initialize rejects with the advice appended", async () => {
    const daemon = fakeDaemon(() => {
      throw new RpcError(DomainErrorCode.VersionMismatch, OLD_DAEMON_LINE);
    });
    const client = new RemoteClient(daemon.connect(), new PermissionBroker());
    await expect(client.initialize()).rejects.toMatchObject({
      code: DomainErrorCode.VersionMismatch,
      message: `${OLD_DAEMON_LINE} — ${OLD_DAEMON_ADVICE}`,
    });
    client.close();
  });

  test("start, an old daemon the runtime knows is a container: the container advice", async () => {
    const daemon = fakeDaemon(() => {
      throw new RpcError(DomainErrorCode.VersionMismatch, OLD_DAEMON_LINE);
    });
    const client = new RemoteClient(daemon.connect(), new PermissionBroker(), undefined, {
      daemonKind: "container",
    });
    await expect(client.initialize()).rejects.toMatchObject({
      message: `${OLD_DAEMON_LINE} — ${oldDaemonAdvice("container")}`,
    });
    client.close();
  });

  test("reconnect to an upgraded daemon: stopped once, with the daemon's advice", async () => {
    let upgraded = false;
    const daemon = fakeDaemon(() => {
      if (!upgraded) return OK;
      const { message, data } = versionMismatch(
        { protocol: PROTOCOL_VERSION, tentacle: "0.1.0", name: "tentacle" },
        { protocol: PROTOCOL_VERSION + 1, identity: { tentacle: "0.2.0", kind: "serve" } },
      );
      throw new RpcError(DomainErrorCode.VersionMismatch, message, data);
    });
    let link: DuplexChannel = daemon.connect();
    const client = new RemoteClient(link, new PermissionBroker(), undefined, {
      clientInfo: { name: "tentacle", version: "0.1.0" },
      channelFactory: async () => {
        link = daemon.connect();
        return link;
      },
      random: () => 0,
    });
    const statuses: LinkStatus[] = [];
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    upgraded = true;
    link.close();
    expect(await until(() => statuses.at(-1)?.state === "stopped")).toBe(true);
    expect(statuses.filter((s) => s.state === "stopped")).toEqual([
      {
        state: "stopped",
        reason: `incompatible daemon: protocol version mismatch: client ${PROTOCOL_VERSION} (tentacle 0.1.0), daemon ${PROTOCOL_VERSION + 1} (tentacle 0.2.0) — update this client: "tentacle update"`,
      },
    ]);
    client.close();
  });

  test("reconnect to an old daemon (no report): stopped with the old-daemon advice", async () => {
    let swapped = false;
    const daemon = fakeDaemon(() => {
      if (!swapped) return OK;
      throw new RpcError(DomainErrorCode.VersionMismatch, OLD_DAEMON_LINE);
    });
    let link: DuplexChannel = daemon.connect();
    const client = new RemoteClient(link, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        link = daemon.connect();
        return link;
      },
      random: () => 0,
    });
    const statuses: LinkStatus[] = [];
    client.onLinkStatus((s) => statuses.push(s));
    await client.initialize();
    swapped = true;
    link.close();
    expect(await until(() => statuses.at(-1)?.state === "stopped")).toBe(true);
    expect(statuses.at(-1)).toEqual({
      state: "stopped",
      reason: `incompatible daemon: ${OLD_DAEMON_LINE} — ${OLD_DAEMON_ADVICE}`,
    });
    client.close();
  });
});
