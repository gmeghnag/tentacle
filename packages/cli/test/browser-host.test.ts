import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_EXTENSION_ID, BROWSER_LINK_VERSION, NativeDecoder } from "@tentacle/browser";
import { encodeNative } from "@tentacle/browser";
import { until } from "../../client/test/support/fakes.ts";
import {
  CHROME_CLOSED_MESSAGE,
  type Hub,
  NO_EXTENSION_MESSAGE,
  VERSION_MESSAGE,
  browserDir,
  createHub,
  hubSocketPath,
  originAllowed,
} from "../src/browser-host.ts";
import { createBrowserLink } from "../src/browser-link.ts";

let dir: string;
let hubs: Hub[] = [];
const links: { dispose(): void }[] = [];
beforeEach(() => {
  // Short: a unix socket path is capped at 103 bytes.
  dir = mkdtempSync(join(tmpdir(), "tb-"));
});
afterEach(async () => {
  for (const l of links.splice(0)) l.dispose();
  for (const h of hubs) await h.stop();
  hubs = [];
  rmSync(dir, { recursive: true, force: true });
});

/** A hub with a fake extension: frames it sends to Chrome are collected. */
function fakeChrome(configDir = dir, opTimeoutMs?: number) {
  const sent: Record<string, unknown>[] = [];
  const decoder = new NativeDecoder({
    onMessage: (m) => sent.push(m as Record<string, unknown>),
    onViolation: () => {},
  });
  const hub = createHub({
    configDir,
    toChrome: (b) => decoder.push(b),
    ...(opTimeoutMs === undefined ? {} : { opTimeoutMs }),
  });
  hubs.push(hub);
  const reply = (msg: unknown) => hub.fromChrome(encodeNative(msg));
  return { hub, sent, reply };
}

function link(daemonId: string, configDir = dir) {
  const l = createBrowserLink({ configDir, daemonId, connectTimeoutMs: 1000 });
  links.push(l);
  return l;
}

describe("browser hub: origin, stale socket, second profile", () => {
  test("only the pinned extension origin may spawn the host", () => {
    expect(originAllowed(`chrome-extension://${BROWSER_EXTENSION_ID}/`)).toBe(true);
    expect(originAllowed("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/")).toBe(false);
    expect(originAllowed(undefined)).toBe(false);
  });

  test("a stale socket file is replaced; a LIVE hub makes the second host exit", async () => {
    mkdirSync(browserDir(dir), { recursive: true });
    writeFileSync(hubSocketPath(dir), "stale");
    const first = fakeChrome();
    expect(await first.hub.start()).toBe(true);
    const second = fakeChrome();
    expect(await second.hub.start()).toBe(false);
    // The live hub is untouched by the refused second host.
    const claim = link("d1").call({ op: "claim", sessionUid: "s1", title: "t" });
    await until(() => first.sent.length === 1);
    first.reply({ id: first.sent[0]?.id, ok: true, result: {} });
    await claim;
    expect(second.sent).toEqual([]);
  });
});

describe("browser hub: ops and ownership (D1)", () => {
  test("claim → open → read reach the extension; an unowned tab never does", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const l = link("d1");
    const claim = l.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    expect(c.sent[0]).toMatchObject({ op: "claim", sessionUid: "s1" });
    c.reply({ id: c.sent[0]?.id, ok: true, result: {} });
    await claim;

    const open = l.call({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    await until(() => c.sent.length === 2);
    c.reply({ id: c.sent[1]?.id, ok: true, result: { tab: 5, title: "A" } });
    expect(await open).toEqual({ tab: 5, title: "A" });

    const read = l.call({ op: "read", sessionUid: "s1", tab: 5, mode: "text" });
    await until(() => c.sent.length === 3);
    c.reply({ id: c.sent[2]?.id, ok: true, result: "hello" });
    expect(await read).toBe("hello");

    // Tab 9 is not ours: refused by the HUB, no frame reaches Chrome.
    await expect(l.call({ op: "read", sessionUid: "s1", tab: 9, mode: "text" })).rejects.toThrow(
      /not one of this session's tabs/,
    );
    expect(c.sent.length).toBe(3);
  });

  test("an op from a session that never claimed is refused without reaching Chrome", async () => {
    const c = fakeChrome();
    await c.hub.start();
    await expect(
      link("d1").call({ op: "open", sessionUid: "nobody", url: "https://a.test/" }),
    ).rejects.toThrow(/does not hold the browser/);
    expect(c.sent).toEqual([]);
  });

  test("two daemons, one session: the second claim is refused; after the first leaves it can claim", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const a = link("dA");
    const p = a.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    c.reply({ id: c.sent[0]?.id, ok: true, result: {} });
    await p;
    await expect(link("dB").call({ op: "claim", sessionUid: "s1", title: "T" })).rejects.toThrow(
      /held by another tentacle process/,
    );
    a.dispose();
    // The lease ended with the connection: the extension is told to release the group.
    await until(() => c.sent.some((m) => m.op === "release" && m.sessionUid === "s1"));
    expect(c.hub.ownership.holds({ daemonId: "dA", sessionUid: "s1" })).toBe(false);
  });

  test("the extension's handover event marks the tab handed-over and owned", async () => {
    const c = fakeChrome();
    await c.hub.start();
    c.reply({ event: "handover", sessionUid: "s1", tab: 7 });
    expect(c.hub.ownership.tabsOf("s1")).toEqual([7]);
    expect(c.hub.ownership.isHandedOver(7)).toBe(true);
  });

  test("tab_closed from Chrome drops ownership and reaches the daemons", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const l = link("d1");
    const events: unknown[] = [];
    l.onEvent((e) => events.push(e));
    const p = l.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    c.reply({ id: c.sent[0]?.id, ok: true, result: {} });
    await p;
    c.hub.ownership.addTab("s1", 5);
    c.reply({ event: "tab_closed", tab: 5 });
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ event: "tab_closed", tab: 5 });
    await expect(l.call({ op: "read", sessionUid: "s1", tab: 5, mode: "text" })).rejects.toThrow(
      /not one of this session's tabs/,
    );
  });
});

describe("browser hub: failure modes", () => {
  test("Chrome quits mid-call: the pending op fails loudly, daemons are told, the socket is gone", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const l = link("d1");
    const events: unknown[] = [];
    l.onEvent((e) => events.push(e));
    const p = l.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    const failed = p.then(
      () => "ok",
      (e: Error) => e.message,
    );
    await c.hub.chromeClosed();
    expect(await failed).toBe(CHROME_CLOSED_MESSAGE);
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ event: "chrome_closed" });
    // No hub any more: a fresh call says the extension is not there.
    const fresh = link("d2");
    await expect(fresh.call({ op: "tabs", sessionUid: "s1" })).rejects.toThrow(
      NO_EXTENSION_MESSAGE,
    );
  });

  test("an op the extension never answers fails after the timeout", async () => {
    const c = fakeChrome(dir, 50);
    await c.hub.start();
    await expect(link("d1").call({ op: "claim", sessionUid: "s1", title: "T" })).rejects.toThrow(
      /did not answer in time/,
    );
  });

  test("an op over Chrome's 1 MB limit is refused locally, not sent", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const l = link("d1");
    const p = l.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    c.reply({ id: c.sent[0]?.id, ok: true, result: {} });
    await p;
    c.hub.ownership.addTab("s1", 5);
    await expect(
      l.call({
        op: "read",
        sessionUid: "s1",
        tab: 5,
        mode: "html",
        selector: "a".repeat(1024 * 1024 + 10),
      }),
    ).rejects.toThrow(/over 1 MB/);
    expect(c.sent.length).toBe(1);
  });

  test("version skew: a hello with another version gets the install hint", async () => {
    const c = fakeChrome();
    await c.hub.start();
    const reply = await new Promise<string>((resolve) => {
      const { createConnection } = require("node:net") as typeof import("node:net");
      const s = createConnection(hubSocketPath(dir));
      s.on("connect", () =>
        s.write(`${JSON.stringify({ version: BROWSER_LINK_VERSION + 1, daemonId: "x" })}\n`),
      );
      s.on("data", (d) => resolve(d.toString()));
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: VERSION_MESSAGE });
  });

  test("no hub: the link says Chrome is not running with the extension, and re-dials later", async () => {
    const l = link("d1");
    await expect(l.call({ op: "tabs", sessionUid: "s1" })).rejects.toThrow(NO_EXTENSION_MESSAGE);
    expect(l.status()).toEqual({ state: "unavailable", reason: NO_EXTENSION_MESSAGE });
    const c = fakeChrome();
    await c.hub.start();
    const claim = l.call({ op: "claim", sessionUid: "s1", title: "T" });
    await until(() => c.sent.length === 1);
    c.reply({ id: c.sent[0]?.id, ok: true, result: {} });
    await claim;
    expect(l.status()).toEqual({ state: "connected" });
  });

  test("a dead listener that is not a hub (never answers) times the dial out", async () => {
    mkdirSync(browserDir(dir), { recursive: true });
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(hubSocketPath(dir), () => r()));
    const l = createBrowserLink({ configDir: dir, daemonId: "d1", connectTimeoutMs: 100 });
    links.push(l);
    await expect(l.call({ op: "tabs", sessionUid: "s1" })).rejects.toThrow(NO_EXTENSION_MESSAGE);
    silent.close();
  });
});
