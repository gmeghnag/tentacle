/**
 * `session/app_unpublish` and the bounded wait of `session/close`
 * (docs/feat/session-apps-publish.md D7/D9), through a real `Connection`.
 */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, Method } from "@tentacle/protocol";
import { appsRig } from "./support/apps-host.ts";
import { gate, settle } from "./support/apps.ts";

describe("session/app_unpublish", () => {
  test("takes the app offline; an unknown one says so", async () => {
    const r = appsRig();
    const client = await r.connect();
    await client.open();
    const row = await r.publish();
    expect(await client.request(Method.AppUnpublish, { app: row.app })).toEqual({ ok: true });
    await settle();
    expect(client.apps().at(-1)?.apps).toEqual([]);
    expect(r.api.calls).toContain(`remove ${row.app}`);
    expect(await client.request(Method.AppUnpublish, { app: row.app })).toMatchObject({
      ok: false,
    });
  });

  test("needs the session open on THIS connection", async () => {
    const r = appsRig();
    const owner = await r.connect();
    await owner.open();
    const row = await r.publish();
    const other = await r.connect();
    await expect(other.request(Method.AppUnpublish, { app: row.app })).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    expect(r.api.calls).toEqual(["create"]);
  });

  test("a host without apps answers, never throws", async () => {
    const r = appsRig({ apps: false });
    const client = await r.connect();
    await client.open();
    expect(await client.request(Method.AppUnpublish, { app: "x" })).toEqual({
      ok: false,
      reason: "this session publishes no apps",
    });
  });

  test("a slow DELETE never holds up another request of the connection", async () => {
    const r = appsRig();
    const client = await r.connect();
    await client.open();
    const row = await r.publish();
    const slow = gate<{ ok: true }>();
    r.api.onRemove = () => slow.promise;
    let done = false;
    const stopping = client.request(Method.AppUnpublish, { app: row.app }).then(() => {
      done = true;
    });
    await settle();
    expect((await client.snapshot()).apps).toEqual([]);
    expect(done).toBe(false);
    slow.resolve({ ok: true });
    await stopping;
  });
});

describe("session/close waits for the DELETEs, never more than 3 s", () => {
  const closing = async () => {
    const r = appsRig();
    const client = await r.connect();
    await client.open();
    await r.publish();
    const slow = gate<{ ok: true }>();
    r.api.onRemove = () => slow.promise;
    let reply: unknown;
    const request = client.request(Method.Close).then((result) => {
      reply = result;
    });
    await settle();
    return { r, slow, request, reply: () => reply };
  };

  test("the session ends at once, the reply follows the DELETE", async () => {
    const { r, slow, request, reply } = await closing();
    expect(r.host.get("S")).toBeUndefined();
    expect(reply()).toBeUndefined();
    slow.resolve({ ok: true });
    await request;
    expect(reply()).toEqual({ closed: true });
    expect(r.clock.timers.size).toBe(0);
  });

  test("a DELETE that never answers: the reply comes at 3 s", async () => {
    const { r, request, reply } = await closing();
    await r.clock.advance(2999);
    expect(reply()).toBeUndefined();
    await r.clock.advance(1);
    await request;
    expect(reply()).toEqual({ closed: true });
  });

  test("no apps: nothing to wait for", async () => {
    const r = appsRig();
    const client = await r.connect();
    await client.open();
    expect(await client.request(Method.Close)).toEqual({ closed: true });
    expect(r.clock.timers.size).toBe(0);
  });
});
