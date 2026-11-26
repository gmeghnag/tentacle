/**
 * docs/feat/session-apps-publish.md — the CLIENT half of session apps. The
 * trust bit gates the feed (a pod's `apps` list is dropped, and its stop sends
 * nothing, AGENTS §7) and the client is the gate for every label. Mutation:
 * remove the `daemonWakes` gate on `apps` → red.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import {
  type AppRow,
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { APPS_OLD_DAEMON, MAX_APP_ROWS, appStateOf, boundApps } from "../src/apps.ts";
import { updateToEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { until } from "./support/fakes.ts";

const row = (i: number, extra: Partial<AppRow> = {}): AppRow => ({
  app: `app${i}`,
  url: `https://app${i}.apps.example.so/`,
  artifactId: "page",
  version: 1,
  title: `Page ${i}`,
  state: "up",
  since: 1,
  publishedAt: 1,
  ...extra,
});

describe("the rows are the client's", () => {
  test("bounded in number and length, escapes and bidi gone", () => {
    expect(boundApps(Array.from({ length: 100 }, (_, i) => row(i)))).toHaveLength(MAX_APP_ROWS);
    const [clean] = boundApps([
      row(1, {
        title: `a\nb\u001b[2J‮${"z".repeat(400)}`,
        reason: `gone\u009b31m${"r".repeat(900)}`,
      }),
    ]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
    const bad = /[\u0000-\u001f\u007f-\u009f‪-‮]/;
    expect(bad.test(clean?.title ?? "")).toBe(false);
    expect(bad.test(clean?.reason ?? "")).toBe(false);
    expect(clean?.title.length).toBeLessThanOrEqual(200);
    expect(clean?.reason?.length).toBeLessThanOrEqual(500);
  });

  test("a state this build does not know is `unknown`, never `up`", () => {
    expect(["up", "renewing", "down", "removed"].map(appStateOf)).toEqual([
      "up",
      "renewing",
      "down",
      "removed",
    ]);
    expect(appStateOf("hibernating")).toBe("unknown");
    expect(appStateOf("UP")).toBe("unknown");
  });

  test("`apps` is a listener's fact, not a turn event", () => {
    expect(updateToEvent({ type: "apps", apps: [] }, new Map())).toBeNull();
  });
});

function fakeDaemon(
  handlers: Record<string, (params: unknown) => unknown> = {},
  snapshot?: Record<string, unknown>,
) {
  const [daemonCh, clientCh] = createChannelPair();
  const sent: { method: string; params: unknown }[] = [];
  let seq = 0;
  const resync = snapshot !== undefined;
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return {
          sessionId: "s1",
          epoch: "e",
          created: !resync,
          resync,
          ...(resync ? { since: { epoch: "e", seq: 0 } } : {}),
        };
      }
      if (method === Method.Snapshot) {
        return { since: { epoch: "e", seq: 0 }, messages: [], ...snapshot };
      }
      const handler = handlers[method];
      if (handler) return handler(params);
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  const notify = (update: unknown): void => {
    peer.notify(Notification.SessionUpdate, { sessionId: "s1", seq: ++seq, update });
  };
  return { sent, notify, clientCh };
}

async function attach(d: ReturnType<typeof fakeDaemon>, daemonWakes: boolean) {
  const client = new RemoteClient(d.clientCh, new PermissionBroker(), undefined, {
    channelFactory: async () => {
      throw new Error("unused");
    },
    random: () => 0,
    ...(daemonWakes ? { daemonWakes } : {}),
  });
  await client.initialize();
  const session = client.newSession(undefined, "s1", undefined, { attach: {} });
  await session.open();
  return { client, session };
}

/** A later frame the client surely handled: every earlier one was too. */
async function flushed(d: ReturnType<typeof fakeDaemon>, session: { jobs?: unknown }) {
  d.notify({ type: "jobs", jobs: [] });
  await until(() => session.jobs !== undefined);
}

describe("the trust bit gates the feed (AGENTS §7)", () => {
  test("trusted: the frame arrives, replays to a late listener, and Stop is sent", async () => {
    const d = fakeDaemon({ [Method.AppUnpublish]: () => ({ ok: true }) });
    const { client, session } = await attach(d, true);
    const seen: number[] = [];
    session.onApps((rows) => seen.push(rows.length));
    d.notify({ type: "apps", apps: [row(1), row(2)] });
    await until(() => seen.length === 1);
    expect(session.apps?.map((r) => r.app)).toEqual(["app1", "app2"]);
    const late: number[] = [];
    session.onApps((rows) => late.push(rows.length));
    expect(late).toEqual([2]);
    expect(await session.unpublishApp("app1")).toEqual({ ok: true });
    expect(d.sent.at(-1)).toEqual({
      method: Method.AppUnpublish,
      params: { sessionId: "s1", app: "app1" },
    });
    client.close();
  });

  test("untrusted (a pod): the frame is DROPPED and Stop sends nothing", async () => {
    const d = fakeDaemon({ [Method.AppUnpublish]: () => ({ ok: true }) });
    const { client, session } = await attach(d, false);
    let notices = 0;
    session.onApps(() => {
      notices += 1;
    });
    d.notify({ type: "apps", apps: [row(1)] });
    await flushed(d, session);
    expect(session.apps).toBeUndefined();
    expect(notices).toBe(0);
    expect(await session.unpublishApp("app1")).toEqual({
      ok: false,
      reason: "this client does not trust its daemon to publish apps",
    });
    expect(d.sent.some((s) => s.method === Method.AppUnpublish)).toBe(false);
    client.close();
  });

  test("a snapshot's list is adopted only when trusted", async () => {
    const on = fakeDaemon({}, { apps: [row(1)] });
    const a = await attach(on, true);
    await until(() => a.session.apps !== undefined);
    expect(a.session.apps?.map((r) => r.app)).toEqual(["app1"]);
    a.client.close();

    const off = fakeDaemon({}, { apps: [row(1)] });
    const b = await attach(off, false);
    await flushed(off, b.session);
    expect(b.session.apps).toBeUndefined();
    b.client.close();
  });

  test("an older daemon: Stop is a typed refusal", async () => {
    const d = fakeDaemon();
    const { client, session } = await attach(d, true);
    expect(await session.unpublishApp("app1")).toEqual({ ok: false, reason: APPS_OLD_DAEMON });
    client.close();
  });
});
