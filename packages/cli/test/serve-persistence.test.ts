import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainErrorCode, PROTOCOL_VERSION, SessionListResultSchema } from "@tentacle/protocol";
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
    for (const key of ["TENTACLE_CONFIG_DIR"]) saved[key] = process.env[key];
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
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
    /** Every `session/update` notification's `update`, in arrival order. */
    const updates: Array<{ type: string } & Record<string, unknown>> = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") replies.set(msg.id, msg);
      else if (msg.method === "session/update") updates.push(msg.params.update);
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
    return { ws, request, updates };
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
      // Idle on reload: the operator is not told to answer a request that does not exist.
      expect(notices.some((l) => l.includes("resumed"))).toBe(false);
      const b = await client(second.url);
      const reopened = await b.request("session/open", { sessionId: "s-e2e" });
      expect(reopened?.result).toMatchObject({ created: false, resync: true });
      const snap = (await b.request("session/snapshot", { sessionId: "s-e2e" }))?.result as {
        messages: unknown[];
      };
      expect(snap.messages).toEqual(seed);
      // close ARCHIVES the daemon's record; only delete removes it.
      await b.request("session/close", { sessionId: "s-e2e" });
      b.ws.close();
    } finally {
      await second.stop();
    }
    const kept = JSON.parse(await readFile(join(daemonStoreDir(config), "s-e2e.json"), "utf8"));
    expect(kept.archivedAt).toEqual(expect.any(Number));
    const third = await serve();
    try {
      const c = await client(third.url);
      expect((await c.request("session/delete", { sessionId: "s-e2e" }))?.result).toEqual({});
      c.ws.close();
    } finally {
      await third.stop();
    }
    expect(await readdir(daemonStoreDir(config))).not.toContain("s-e2e.json");
  });

  test("S1 a restart brings archived records back ARCHIVED (indexed, not live), live ones live; one list", async () => {
    // Mutation M8: parseDaemonRecord drops archivedAt (an archived record restored live) → red.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "s-live", messages: seed });
    await a.request("session/open", { sessionId: "s-arch", messages: seed });
    await a.request("session/close", { sessionId: "s-arch" });
    a.ws.close();
    await first.stop();
    const archivedFile = JSON.parse(
      await readFile(join(daemonStoreDir(config), "s-arch.json"), "utf8"),
    );
    expect(archivedFile.schemaVersion).toBe(4);
    expect(archivedFile.archivedAt).toEqual(expect.any(Number));

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      expect(notices.some((l) => l.startsWith("restored 1 session, 1 archived, from"))).toBe(true);
      const b = await client(second.url);
      const result = (await b.request("session/list", {}))?.result;
      expect(SessionListResultSchema.safeParse(result).success).toBe(true);
      const byId = Object.fromEntries(
        (
          result as { sessions: { sessionId: string; archived: boolean; cwd: string }[] }
        ).sessions.map((s) => [s.sessionId, [s.archived, s.cwd]]),
      );
      expect(byId).toEqual({ "s-live": [false, config.cwd], "s-arch": [true, config.cwd] });
      // Not live: a plain open is refused as archived; the explicit reopen reads it from disk.
      const plain = await b.request("session/open", { sessionId: "s-arch" });
      expect(plain?.error?.code).toBe(DomainErrorCode.SessionArchived);
      const reopened = await b.request("session/open", { sessionId: "s-arch", reopen: true });
      expect(reopened?.result).toMatchObject({ created: false, resync: true });
      const snap = (await b.request("session/snapshot", { sessionId: "s-arch" }))?.result as {
        messages: unknown[];
      };
      expect(snap.messages).toEqual(seed);
      b.ws.close();
    } finally {
      await second.stop();
    }
    // Reopened = live again: its record lost the stamp.
    const after = JSON.parse(await readFile(join(daemonStoreDir(config), "s-arch.json"), "utf8"));
    expect(after.archivedAt).toBeUndefined();
  });

  test("S2 a v1 record (an older build's format) restores live after the upgrade, rewritten at the current version", async () => {
    // Mutation: refuse schemaVersion 1 → skipped "unsupported record version 1".
    const record = {
      id: "s-v1",
      cwd: config.cwd,
      model: config.model,
      createdAt: 1,
      updatedAt: 2,
      title: "t",
      kind: "tentacle.daemon-session",
      schemaVersion: 1,
      lastActiveAt: 2,
      enqueueIds: [],
      turns: [],
      messages: seed,
    };
    await mkdir(daemonStoreDir(config), { recursive: true });
    const file = join(daemonStoreDir(config), "s-v1.json");
    await writeFile(file, JSON.stringify(record));
    const notices: string[] = [];
    const daemon = await serve(config, notices);
    try {
      expect(notices.filter((l) => l.startsWith("skipped"))).toEqual([]);
      expect(notices.some((l) => l.startsWith("restored 1 session from"))).toBe(true);
      const c = await client(daemon.url);
      const opened = await c.request("session/open", { sessionId: "s-v1" });
      expect(opened?.result).toMatchObject({ created: false });
      c.ws.close();
    } finally {
      await daemon.stop();
    }
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.schemaVersion).toBe(4);
    expect(after.archivedAt).toBeUndefined();
  });

  test("B7 a turn suspended at a restart is asked again over the wire; cancel converges on disk", async () => {
    // Mutation: drop `resume` from SessionHost.restore → no notice, no request, the turn is closed.
    // The record a serve leaves when it stops while `shell` waits for approval.
    const record = {
      id: "s-resume",
      cwd: config.cwd,
      model: config.model,
      createdAt: 1,
      updatedAt: 2,
      title: "t",
      kind: "tentacle.daemon-session",
      schemaVersion: 1,
      lastActiveAt: 2,
      enqueueIds: [],
      turns: [{ turnId: "T1" }],
      messages: [
        { role: "user", content: "say hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "shell", arguments: '{"command":"echo hi"}' }],
        },
      ],
      turn: {
        turnId: "T1",
        steering: [],
        pending: { toolCallId: "c1", tool: "shell", resumable: true, requestedAt: 2 },
      },
    };
    await mkdir(daemonStoreDir(config), { recursive: true });
    const file = join(daemonStoreDir(config), "s-resume.json");
    await writeFile(file, JSON.stringify(record));
    const notices: string[] = [];
    const daemon = await serve(config, notices);
    try {
      expect(notices.some((l) => /restored 1 session .*1 resumed a turn waiting/.test(l))).toBe(
        true,
      );
      const c = await client(daemon.url);
      const opened = await c.request("session/open", { sessionId: "s-resume" });
      expect(opened?.result).toMatchObject({ created: false, resync: true });
      await until(() => c.updates.some((u) => u.type === "permission_request"));
      const ask = c.updates.find((u) => u.type === "permission_request");
      expect(ask).toMatchObject({ toolCallId: "c1", tool: "shell" });
      expect(c.updates.some((u) => u.type === "turn_start")).toBe(false);
      const snap = (await c.request("session/snapshot", { sessionId: "s-resume" }))?.result as {
        turn?: unknown;
      };
      expect(snap.turn).toEqual({ turnId: "T1" });
      // Cancel (no model call, nothing runs): the turn ends and the disk forgets it.
      // `session/cancel` is a notification.
      c.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: "s-resume" },
        }),
      );
      await until(() => c.updates.some((u) => u.type === "turn_end"));
      expect(c.updates.find((u) => u.type === "turn_end")).toMatchObject({
        turnId: "T1",
        stopReason: "cancelled",
      });
      c.ws.close();
    } finally {
      await daemon.stop();
    }
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.turn).toBeUndefined();
    expect(after.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(after.turns).toEqual([{ turnId: "T1", end: { stopReason: "cancelled" } }]);
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
      newer: JSON.stringify({ ...good, id: "newer", schemaVersion: 5 }),
      foreign: JSON.stringify({ ...good, id: "foreign", cwd: "/another/project" }),
    };
    for (const [id, text] of Object.entries(bad)) await writeFile(join(store, `${id}.json`), text);

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      const skipped = notices.filter((l) => l.startsWith("skipped "));
      expect(skipped).toHaveLength(4);
      expect(skipped.find((l) => l.includes("newer.json"))).toMatch(/unsupported record version 5/);
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

  test("R10 a record with a non-integer updatedAt is skipped loudly; session/list stays valid for the rest", async () => {
    // Review finding 2. Mutation: drop the integer check in parseDaemonRecord → the
    // record loads, its entry carries 1.5 and the list fails the client's schema.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "good", messages: seed });
    a.ws.close();
    await first.stop();
    const store = daemonStoreDir(config);
    const good = JSON.parse(await readFile(join(store, "good.json"), "utf8"));
    const badText = JSON.stringify({ ...good, id: "bad-stamp", updatedAt: 1.5 });
    await writeFile(join(store, "bad-stamp.json"), badText);

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      const b = await client(second.url);
      const result = (await b.request("session/list", {}))?.result;
      // What a RemoteClient's peer checks: one bad entry would reject the whole page.
      expect(SessionListResultSchema.safeParse(result).success).toBe(true);
      expect(
        (result as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId),
      ).toEqual(["good"]);
      b.ws.close();
      // Hidden, never silently: the existing startup report names the file and why.
      expect(notices.find((l) => l.includes("bad-stamp.json"))).toMatch(
        /^skipped .*"updatedAt" is not a non-negative integer \(left as is\)$/,
      );
      expect(notices.some((l) => l.startsWith("restored 1 session"))).toBe(true);
    } finally {
      await second.stop();
    }
    expect(await readFile(join(store, "bad-stamp.json"), "utf8")).toBe(badText);
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

  test("F1 a deleted session is never revived: its tombstone survives a restart (the Review's repro)", async () => {
    // Mutation: `delete` keeps no tombstone (or `serve` does not reload it) → the
    // reconnect is UnknownSession and the client's recreate builds it again.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "s-del", messages: seed });
    await a.request("session/open", { sessionId: "s-del-arch", messages: seed });
    await a.request("session/close", { sessionId: "s-del-arch" });
    expect((await a.request("session/delete", { sessionId: "s-del" }))?.result).toEqual({});
    expect((await a.request("session/delete", { sessionId: "s-del-arch" }))?.result).toEqual({});
    a.ws.close();
    await first.stop();
    const files = await readdir(daemonStoreDir(config));
    expect(files).not.toContain("s-del.json");
    expect(files).not.toContain("s-del-arch.json");

    const second = await serve();
    try {
      const b = await client(second.url);
      for (const id of ["s-del", "s-del-arch"]) {
        // The offline client's reconnect, then its recreate from its own copy.
        for (const params of [
          { sessionId: id, since: { epoch: "e", seq: 3 } },
          { sessionId: id, messages: seed },
          { sessionId: id, create: true },
          { sessionId: id, reopen: true },
        ]) {
          expect((await b.request("session/open", params))?.error?.code).toBe(
            DomainErrorCode.SessionDeleted,
          );
        }
      }
      const listed = SessionListResultSchema.parse(
        (await b.request("session/list", {}))?.result,
      ).sessions;
      expect(listed).toEqual([]);
      // Idempotent, and a fresh id is unaffected.
      expect((await b.request("session/delete", { sessionId: "s-del" }))?.result).toEqual({});
      const fresh = await b.request("session/open", { sessionId: "s-other", create: true });
      expect(fresh?.result).toMatchObject({ created: true });
      b.ws.close();
    } finally {
      await second.stop();
    }
    expect(await readdir(daemonStoreDir(config))).not.toContain("s-del.json");
  });

  test("R2-3 a garbled tombstone line is skipped WITH a start notice; the valid ones still hold", async () => {
    // Mutation: the load drops invalid lines without reporting them → no notice.
    const store = daemonStoreDir(config);
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "deleted-sessions"), "s-gone\n../evil\n");
    const notices: string[] = [];
    const handle = await serve(config, notices);
    try {
      expect(notices.some((l) => l.includes("deleted-sessions") && l.includes("../evil"))).toBe(
        true,
      );
      const c = await client(handle.url);
      expect(
        (await c.request("session/open", { sessionId: "s-gone", create: true }))?.error?.code,
      ).toBe(DomainErrorCode.SessionDeleted);
      c.ws.close();
    } finally {
      await handle.stop();
    }
  });

  test("R2-4 an unreadable tombstone file → serve refuses to start (naming file and cause); a missing one is fine", async () => {
    // Mutation: the start only warns (the old behaviour) → startDaemon resolves.
    const store = daemonStoreDir(config);
    await mkdir(join(store, "deleted-sessions"), { recursive: true }); // exists, cannot be read (EISDIR)
    const error = await serve().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(join(store, "deleted-sessions"));
    expect((error as Error).message).toContain("EISDIR");
    // The lock was released: with the file gone, the next start works.
    await rm(join(store, "deleted-sessions"), { recursive: true });
    const handle = await serve();
    await handle.stop();
  });

  test("F1 a record left by a delete cut short (tombstone written, file not yet removed) is not restored", async () => {
    // Mutation: the start loop ignores the tombstones → the record is restored live.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "s-half", messages: seed });
    a.ws.close();
    await first.stop();
    const file = join(daemonStoreDir(config), "s-half.json");
    const bytes = await readFile(file, "utf8");
    const second = await serve();
    const b = await client(second.url);
    await b.request("session/delete", { sessionId: "s-half" });
    b.ws.close();
    await second.stop();
    // The crash window: the file is back as it was, the tombstone is on disk.
    await writeFile(file, bytes);
    const notices: string[] = [];
    const third = await serve(config, notices);
    try {
      expect(notices.some((l) => l.startsWith("restored"))).toBe(false);
      const c = await client(third.url);
      expect((await c.request("session/open", { sessionId: "s-half" }))?.error?.code).toBe(
        DomainErrorCode.SessionDeleted,
      );
      c.ws.close();
    } finally {
      await third.stop();
    }
    // The interrupted removal is finished.
    expect(await readdir(daemonStoreDir(config))).not.toContain("s-half.json");
  });
});
