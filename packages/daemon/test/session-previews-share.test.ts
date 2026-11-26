/**
 * Shared rows of a session (docs/feat/session-apps-container-ports.md OD3, OD6):
 * the secret stays here, the row follows the tunnel, and every way a row goes
 * unpublishes it. Fake sharer, fake resolver.
 */
import { describe, expect, test } from "bun:test";
import type { PreviewFacts, PreviewResolution, PreviewResolver } from "@tentacle/core";
import { SessionPreviews } from "../src/session-previews.ts";
import { fakeSharer } from "./support/sharer.ts";

const FACTS: PreviewFacts = {
  engine: "docker",
  endpointLabel: "unix:///x.sock",
  id: "c".repeat(64),
  name: "web",
  image: "nginx",
  imageId: "sha256:1",
  containerPort: 80,
  hostPort: 8080,
  hostIp: "127.0.0.1",
};

function setup(resolve?: () => Promise<PreviewResolution>) {
  let resolves = 0;
  const resolver: PreviewResolver = {
    prepare: async () => ({ ok: true, facts: FACTS }),
    resolve: async () => {
      resolves += 1;
      return resolve ? resolve() : { ok: true, facts: FACTS };
    },
  };
  let changes = 0;
  const sharer = fakeSharer();
  const previews = new SessionPreviews(
    resolver,
    () => {
      changes += 1;
    },
    () => 1,
    sharer,
  );
  const share = async (open = false) => {
    const added = await previews.share?.add(FACTS, { public: open });
    if (!added?.ok) throw new Error(added?.reason ?? "no sharing");
    return added.row;
  };
  return { previews, sharer, share, resolves: () => resolves, changes: () => changes };
}

describe("a shared row", () => {
  test("carries the public address, never the secret", async () => {
    const t = setup();
    const row = await t.share();
    const secret = t.sharer.opened[0]?.secret ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row.link).toEqual({ url: t.sharer.url(0), state: "connecting", public: false });
    expect(JSON.stringify(t.previews.list())).not.toContain(secret);
    expect(t.previews.linkOf(row.id)).toBe(`${t.sharer.url(0)}__tentacle/cap/${secret}`);
  });

  test("a public one has no secret and its link is the address", async () => {
    const t = setup();
    const row = await t.share(true);
    expect(t.sharer.opened[0]?.secret).toBeUndefined();
    expect(row.link?.public).toBe(true);
    expect(t.previews.linkOf(row.id)).toBe(t.sharer.url(0));
  });

  test("each share has its own secret", async () => {
    const t = setup();
    await t.share();
    await t.share();
    expect(t.sharer.opened[0]?.secret).not.toBe(t.sharer.opened[1]?.secret);
  });

  test("a device preview has no link", async () => {
    const t = setup();
    const added = t.previews.add(FACTS);
    if (!added.ok) throw new Error(added.reason);
    expect(t.previews.linkOf(added.row.id)).toBeUndefined();
  });

  test("the tunnel's state shows on the row", async () => {
    const t = setup();
    const row = await t.share();
    const before = t.changes();
    t.sharer.opened[0]?.onState("up");
    expect(t.previews.list()[0]?.link?.state).toBe("up");
    t.sharer.opened[0]?.onState("up");
    expect(t.changes()).toBe(before + 1);
    expect(t.previews.list()[0]?.id).toBe(row.id);
  });

  test("the host ending it removes the row and the secret", async () => {
    const t = setup();
    const row = await t.share();
    t.sharer.opened[0]?.onEnded("taken_down");
    expect(t.previews.list()).toEqual([]);
    expect(t.previews.linkOf(row.id)).toBeUndefined();
    expect(t.sharer.stopped).toEqual([0]);
  });

  test("stop, a gone container and the session's end each unpublish", async () => {
    let gone = false;
    const t = setup(async () =>
      gone ? { ok: false, reason: "stopped" } : { ok: true, facts: FACTS },
    );
    const a = await t.share();
    const b = await t.share();
    await t.share();
    t.previews.remove(a.id, "stopped");
    expect(t.sharer.stopped).toEqual([0]);
    gone = true;
    await t.previews.connect(b.id);
    expect(t.sharer.stopped).toEqual([0, 1]);
    t.previews.close();
    expect(t.sharer.stopped).toEqual([0, 1, 2]);
    expect(await t.previews.share?.add(FACTS, { public: false })).toMatchObject({ ok: false });
  });

  test("a refused creation adds nothing", async () => {
    const t = setup();
    t.sharer.refuse("the apps host refused: cap_reached");
    const added = await t.previews.share?.add(FACTS, { public: false });
    expect(added).toMatchObject({ ok: false, reason: "the apps host refused: cap_reached" });
    expect(t.previews.list()).toEqual([]);
  });

  test("a session ending while the host creates: unpublished, no row", async () => {
    const t = setup();
    const release = t.sharer.hold();
    const pending = t.previews.share?.add(FACTS, { public: false });
    t.previews.close();
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(t.sharer.discarded).toEqual([0]);
    expect(t.sharer.opened).toEqual([]);
  });

  test("a cancelled call is unpublished", async () => {
    const t = setup();
    const abort = new AbortController();
    const release = t.sharer.hold();
    const pending = t.previews.share?.add(FACTS, { public: false, signal: abort.signal });
    abort.abort();
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(t.sharer.discarded).toEqual([0]);
    expect(t.previews.list()).toEqual([]);
  });

  test("concurrent connects share ONE inspect; a later one inspects again", async () => {
    let release: (() => void) | undefined;
    const t = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, facts: FACTS });
        }),
    );
    const row = await t.share();
    const a = t.previews.connect(row.id);
    const b = t.previews.connect(row.id);
    release?.();
    expect(await Promise.all([a, b])).toEqual([
      { ok: true, hostPort: 8080 },
      { ok: true, hostPort: 8080 },
    ]);
    expect(t.resolves()).toBe(1);
    const c = t.previews.connect(row.id);
    release?.();
    await c;
    expect(t.resolves()).toBe(2);
  });

  test("a host that shares nothing offers no sharing", () => {
    const previews = new SessionPreviews(
      {
        prepare: async () => ({ ok: false, reason: "" }),
        resolve: async () => ({ ok: false, reason: "" }),
      },
      () => {},
    );
    expect(previews.share).toBeUndefined();
  });
});
