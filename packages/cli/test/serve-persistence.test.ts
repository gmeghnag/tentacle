import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { daemonStoreDir, startDaemon } from "../src/serve.ts";

// `serve` persists its sessions on its own host and reloads them on start
// (docs/feat/daemon-side-persistence.md), over a REAL disk under a temp
// configDir. Each test names the mutation that must turn it red (AGENTS §9).

describe("serve persistence (end to end, real disk)", () => {
  let dir: string;
  let config: TentacleConfig;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-persist-"));
    for (const key of ["TENTACLE_CONFIG_DIR", "TENTACLE_CWD"]) saved[key] = process.env[key];
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
    process.env.TENTACLE_CWD = dir;
    config = await loadConfig({ cwd: dir });
  });

  afterEach(async () => {
    await rm(join(dir, "config", "daemon"), { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** A raw JSON-RPC client over the daemon's WebSocket. */
  async function client(url: string) {
    const ws = new WebSocket(url);
    const replies = new Map<number, { result?: unknown; error?: { code: number } }>();
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    };
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const n = ++id;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      await until(() => replies.has(n));
      return replies.get(n);
    };
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    return { ws, request };
  }

  const seed = [
    { role: "user", content: "remember me" },
    { role: "assistant", content: "I will" },
  ];
  const serve = (cfg: TentacleConfig = config, notices: string[] = []) =>
    startDaemon(cfg, { host: "127.0.0.1", port: 0, onNotice: (l) => notices.push(l) });

  test("A13 a session survives a serve restart; the daemon's copy is served on re-open", async () => {
    // Mutation: drop `sessionHost.restore` in startDaemon → UnknownSession after the restart.
    const first = await serve();
    const a = await client(first.url);
    const opened = await a.request("session/open", { sessionId: "s-e2e", messages: seed });
    expect(opened?.result).toMatchObject({ sessionId: "s-e2e", created: true });
    a.ws.close();
    await first.stop();
    expect(await readdir(daemonStoreDir(config))).toContain("s-e2e.json");

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      expect(notices.some((l) => l.startsWith("restored 1 session from"))).toBe(true);
      const b = await client(second.url);
      const reopened = await b.request("session/open", { sessionId: "s-e2e" });
      expect(reopened?.result).toMatchObject({ created: false, resync: true });
      const snap = (await b.request("session/snapshot", { sessionId: "s-e2e" }))?.result as {
        messages: unknown[];
      };
      expect(snap.messages).toEqual(seed);
      // close deletes the daemon's record (the client keeps its own copy).
      await b.request("session/close", { sessionId: "s-e2e" });
      b.ws.close();
    } finally {
      await second.stop();
    }
    expect(await readdir(daemonStoreDir(config))).not.toContain("s-e2e.json");
  });

  test("A11 unusable records are reported, left byte-identical, and never overwritten", async () => {
    // Mutation: skip either `persister.block` in startDaemon → opening that uid overwrites (then deletes) the file.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "good", messages: seed });
    a.ws.close();
    await first.stop();
    const store = daemonStoreDir(config);
    const good = JSON.parse(await readFile(join(store, "good.json"), "utf8"));
    const bad: Record<string, string> = {
      truncated: JSON.stringify({ ...good, id: "truncated" }).slice(0, 40),
      "client-shaped": JSON.stringify({ ...good, id: "client-shaped", kind: undefined }),
      newer: JSON.stringify({ ...good, id: "newer", schemaVersion: 2 }),
      foreign: JSON.stringify({ ...good, id: "foreign", cwd: "/another/project" }),
    };
    for (const [id, text] of Object.entries(bad)) await writeFile(join(store, `${id}.json`), text);

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      const skipped = notices.filter((l) => l.startsWith("skipped "));
      expect(skipped).toHaveLength(4);
      expect(skipped.find((l) => l.includes("newer.json"))).toMatch(/unsupported record version 2/);
      expect(skipped.find((l) => l.includes("foreign.json"))).toMatch(/another project/);
      expect(skipped.find((l) => l.includes("client-shaped.json"))).toMatch(/not a daemon session/);
      expect(skipped.find((l) => l.includes("truncated.json"))).toMatch(/invalid JSON/);
      expect(notices.some((l) => l.startsWith("restored 1 session"))).toBe(true);
      // A client opening a skipped uid gets a session — in memory only.
      const b = await client(second.url);
      // Both kinds of skip: one `list()` could not read, one the daemon would not accept.
      for (const sessionId of ["truncated", "newer"]) {
        const opened = await b.request("session/open", { sessionId, messages: seed });
        expect(opened?.result).toMatchObject({ created: true });
        await b.request("session/close", { sessionId });
      }
      b.ws.close();
    } finally {
      await second.stop();
    }
    for (const [id, text] of Object.entries(bad)) {
      expect(await readFile(join(store, `${id}.json`), "utf8")).toBe(text);
    }
  });

  test("R6 the same project reached through a symlink restores its sessions", async () => {
    // Mutation: compare the record's cwd as a raw string → skipped as "another project".
    const { symlink } = await import("node:fs/promises");
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "via-link", messages: seed });
    a.ws.close();
    await first.stop();
    const link = join(dir, "..", `${dir.split("/").at(-1)}-link`);
    await symlink(dir, link);
    try {
      const notices: string[] = [];
      const second = await serve({ ...config, cwd: link }, notices);
      await second.stop();
      expect(notices.filter((l) => l.startsWith("skipped"))).toEqual([]);
      expect(notices.some((l) => l.startsWith("restored 1 session"))).toBe(true);
    } finally {
      await rm(link, { force: true });
    }
  });

  test("A12 one serve per project store: a second refuses; a dead holder is taken over; another project is free", async () => {
    // Mutation: skip `acquireStoreLock` → the second serve starts on the same store.
    const first = await serve();
    try {
      await expect(serve()).rejects.toThrow(
        new RegExp(`another tentacle serve \\(pid ${process.pid}\\) owns`),
      );
      const otherCwd = join(dir, "other-project");
      await mkdir(otherCwd, { recursive: true });
      const other = await serve({ ...config, cwd: otherCwd });
      expect(daemonStoreDir({ ...config, cwd: otherCwd })).not.toBe(daemonStoreDir(config));
      await other.stop();
    } finally {
      await first.stop();
    }
    // Released on stop: a new serve starts.
    const again = await serve();
    await again.stop();
    // A startup failure AFTER the lock was taken (the port is busy) releases it.
    const holder = await serve();
    const otherCwd2 = join(dir, "busy-port-project");
    await mkdir(otherCwd2, { recursive: true });
    const busy = { ...config, cwd: otherCwd2 };
    const port = Number(new URL(holder.url).port);
    await expect(startDaemon(busy, { host: "127.0.0.1", port })).rejects.toThrow();
    await holder.stop();
    const afterFailure = await serve(busy); // Mutation: no `lock.release()` in the catch → refused.
    await afterFailure.stop();
    // A lock left by a dead process is stale.
    const child = Bun.spawn(["true"]);
    await child.exited;
    const dead = child.pid;
    await writeFile(join(daemonStoreDir(config), ".lock"), String(dead));
    const takeover = await serve();
    await takeover.stop();
  });
});
