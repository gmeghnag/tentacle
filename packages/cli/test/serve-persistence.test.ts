import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainErrorCode, PROTOCOL_VERSION, SessionListResultSchema } from "@tentacle/protocol";
import { decodeFiles, filesOf } from "../../daemon/test/support/daemon-store-spy.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { daemonStoreDir, startDaemon } from "../src/serve.ts";
import { toolOutputStore } from "../src/wiring.ts";

// `serve` persists its sessions on its own host and reloads them on start
// (docs/feat/daemon-side-persistence.md; the files: docs/feat/session-log-serve-store.md),
// over a REAL disk under a temp configDir. Each test names the mutation that
// must turn it red (AGENTS §9).

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

  // A session on disk: its log `<id>.jsonl` and its state file `<id>.state.json`
  // (docs/feat/session-log-serve-store.md).
  const logPath = (id: string) => join(daemonStoreDir(config), `${id}.jsonl`);
  const statePath = (id: string) => join(daemonStoreDir(config), `${id}.state.json`);
  const stateOf = async (id: string) =>
    JSON.parse(await readFile(statePath(id), "utf8")) as Record<string, unknown>;
  /** The session as a restart loads it (the real decoders over the two files). */
  const loadedOf = async (id: string) =>
    decodeFiles(id, {
      log: await readFile(logPath(id), "utf8"),
      state: await readFile(statePath(id), "utf8"),
    });

  test("A13 a session survives a serve restart; the daemon's copy is served on re-open", async () => {
    // Mutation: drop `sessionHost.restore` in startDaemon → UnknownSession after the restart.
    const first = await serve();
    const a = await client(first.url);
    const opened = await a.request("session/open", { sessionId: "s-e2e", messages: seed });
    expect(opened?.result).toMatchObject({ sessionId: "s-e2e", created: true });
    a.ws.close();
    await first.stop();
    expect(await readdir(daemonStoreDir(config))).toEqual(
      expect.arrayContaining(["s-e2e.jsonl", "s-e2e.state.json"]),
    );

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
    const kept = await stateOf("s-e2e");
    expect(kept.archivedAt).toEqual(expect.any(Number));
    const third = await serve();
    try {
      const c = await client(third.url);
      expect((await c.request("session/delete", { sessionId: "s-e2e" }))?.result).toEqual({});
      c.ws.close();
    } finally {
      await third.stop();
    }
    const left = await readdir(daemonStoreDir(config));
    expect(left).not.toContain("s-e2e.jsonl");
    expect(left).not.toContain("s-e2e.state.json");
  });

  test("S1 a restart brings archived records back ARCHIVED (indexed, not live), live ones live; one list", async () => {
    // Mutation M8: the state-file loader drops archivedAt (an archived record restored live) → red.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "s-live", messages: seed });
    await a.request("session/open", { sessionId: "s-arch", messages: seed });
    await a.request("session/close", { sessionId: "s-arch" });
    a.ws.close();
    await first.stop();
    const archivedFile = await stateOf("s-arch");
    expect(archivedFile.format).toBe("tentacle-daemon-state");
    expect(archivedFile.schemaVersion).toBe(1); // DAEMON_STATE_VERSION
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
    const after = await stateOf("s-arch");
    expect(after.archivedAt).toBeUndefined();
  });

  test("S2 (FM 23) a legacy `<uid>.json` record is ignored silently and left byte-identical", async () => {
    // Owner: no conversion, no back-compat. Mutation: scan `*.json` → a notice / a restore.
    const record = {
      id: "s-v8",
      cwd: config.cwd,
      model: config.model,
      createdAt: 1,
      updatedAt: 2,
      title: "t",
      kind: "tentacle.daemon-session",
      schemaVersion: 8,
      lastActiveAt: 2,
      enqueueIds: [],
      turns: [],
      returned: [],
      messages: seed,
    };
    await mkdir(daemonStoreDir(config), { recursive: true });
    const file = join(daemonStoreDir(config), "s-v8.json");
    const text = JSON.stringify(record);
    await writeFile(file, text);
    const notices: string[] = [];
    const daemon = await serve(config, notices);
    try {
      expect(notices).toEqual([]);
      const c = await client(daemon.url);
      expect((await c.request("session/open", { sessionId: "s-v8" }))?.error?.code).toBe(
        DomainErrorCode.UnknownSession,
      );
      c.ws.close();
    } finally {
      await daemon.stop();
    }
    expect(await readFile(file, "utf8")).toBe(text);
  });

  test("FM 5 / FM 25: a log with no state file is set aside (id free); a state file with no log is removed", async () => {
    // Mutations: block the no-state log instead (`skipped`, id taken) → red; skip the
    // orphan sweep → the state file stays.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "cut", messages: seed });
    await a.request("session/open", { sessionId: "orphan", messages: seed });
    a.ws.close();
    await first.stop();
    const cutLog = await readFile(logPath("cut"), "utf8");
    await rm(statePath("cut")); // its first unit's state file never landed
    await rm(logPath("orphan")); // a removal cut short between the two files
    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      const names = await readdir(daemonStoreDir(config));
      expect(names).not.toContain("cut.jsonl");
      expect(names).not.toContain("orphan.state.json");
      const aside = names.find((n) => n.startsWith("cut.stale-") && n.endsWith(".aside"));
      expect(aside).toBeDefined();
      expect(await readFile(join(daemonStoreDir(config), aside ?? ""), "utf8")).toBe(cutLog);
      expect(notices.some((l) => l.includes("aside") && l.includes("no state file"))).toBe(true);
      expect(notices.filter((l) => l.startsWith("skipped"))).toEqual([]);
      // The id is free again: as today, the session cut before its first save does not exist.
      const b = await client(second.url);
      expect((await b.request("session/open", { sessionId: "cut" }))?.error?.code).toBe(
        DomainErrorCode.UnknownSession,
      );
      expect(
        (await b.request("session/open", { sessionId: "cut", create: true }))?.result,
      ).toMatchObject({ created: true });
      b.ws.close();
    } finally {
      await second.stop();
    }
  });

  test("FM 5 / M2: only a readable log header of THIS version with no state file is set aside; a newer or corrupt one is skipped, untouched", async () => {
    // Mutation: the missing-state check before the header parse in `loadState` → the
    // newer and corrupt logs are moved to `.aside` (review M2).
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "cut", messages: seed });
    a.ws.close();
    await first.stop();
    const goodLog = await readFile(logPath("cut"), "utf8");
    const nl = goodLog.indexOf("\n");
    const header = JSON.parse(goodLog.slice(0, nl)) as Record<string, unknown>;
    const body = goodLog.slice(nl + 1);
    await rm(logPath("cut"));
    await rm(statePath("cut"));
    const logs: Record<string, string> = {
      "newer-nostate": `${JSON.stringify({ ...header, id: "newer-nostate", schemaVersion: 99 })}\n${body}`,
      "corrupt-nostate": `{"format":"tentacle-session-log", broken\n${body}`,
      "current-nostate": `${JSON.stringify({ ...header, id: "current-nostate" })}\n${body}`,
    };
    for (const [id, text] of Object.entries(logs)) await writeFile(logPath(id), text);
    const notices: string[] = [];
    const second = await serve(config, notices);
    await second.stop();
    const names = await readdir(daemonStoreDir(config));
    for (const id of ["newer-nostate", "corrupt-nostate"]) {
      expect(await readFile(logPath(id), "utf8")).toBe(logs[id] ?? "");
      expect(names.some((n) => n.startsWith(`${id}.stale-`))).toBe(false);
      expect(notices.find((l) => l.startsWith("skipped") && l.includes(`/${id}.jsonl`))).toMatch(
        /\(left as is\)$/,
      );
    }
    // The readable current-version header: FM 5, set aside with its bytes.
    expect(names).not.toContain("current-nostate.jsonl");
    const aside = names.find((n) => n.startsWith("current-nostate.stale-"));
    expect(aside).toBeDefined();
    expect(await readFile(join(daemonStoreDir(config), aside ?? ""), "utf8")).toBe(
      logs["current-nostate"] ?? "",
    );
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
      lastActiveAt: 2,
      enqueueIds: [],
      returned: [],
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
        steeringIds: [],
        pending: [{ toolCallId: "c1", tool: "shell", resumable: true, requestedAt: 2 }],
      },
    };
    await mkdir(daemonStoreDir(config), { recursive: true });
    const files = filesOf(record as unknown as Parameters<typeof filesOf>[0]);
    await writeFile(logPath("s-resume"), files.log ?? "");
    await writeFile(statePath("s-resume"), files.state ?? "");
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
    const after = await loadedOf("s-resume");
    expect(after.paired).toBe(true);
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
    // (FM 22) Each bad session as its two files: the good one's, re-identified, then broken.
    const goodLog = await readFile(logPath("good"), "utf8");
    const goodState = await stateOf("good");
    const header = JSON.parse(goodLog.slice(0, goodLog.indexOf("\n"))) as Record<string, unknown>;
    const body = goodLog.slice(goodLog.indexOf("\n") + 1);
    const logFor = (id: string, over: Record<string, unknown> = {}) =>
      `${JSON.stringify({ ...header, id, ...over })}\n${body}`;
    const stateFor = (id: string, over: Record<string, unknown> = {}) =>
      JSON.stringify({ ...goodState, id, ...over });
    const bad: Record<string, { log: string; state: string }> = {
      truncated: { log: logFor("truncated"), state: stateFor("truncated").slice(0, 40) },
      "client-shaped": {
        log: logFor("client-shaped"),
        state: stateFor("client-shaped", { format: "tentacle.daemon-session" }),
      },
      newer: { log: logFor("newer"), state: stateFor("newer", { schemaVersion: 2 }) },
      "newer-log": { log: logFor("newer-log", { schemaVersion: 2 }), state: stateFor("newer-log") },
      foreign: { log: logFor("foreign", { cwd: "/another/project" }), state: stateFor("foreign") },
      "corrupt-log": {
        log: `${logFor("corrupt-log")}{"type":"message","not json\n`,
        state: stateFor("corrupt-log"),
      },
    };
    for (const [id, f] of Object.entries(bad)) {
      await writeFile(logPath(id), f.log);
      await writeFile(statePath(id), f.state);
    }

    const notices: string[] = [];
    const second = await serve(config, notices);
    try {
      const skipped = notices.filter((l) => l.startsWith("skipped "));
      expect(skipped).toHaveLength(6);
      const about = (id: string) => skipped.find((l) => l.includes(`/${id}.jsonl`));
      expect(about("newer")).toMatch(/state file schemaVersion 2 is not 1/);
      expect(about("newer-log")).toMatch(/session log schemaVersion 2 is not 1/);
      expect(about("foreign")).toMatch(/another project/);
      expect(about("client-shaped")).toMatch(/not a tentacle daemon state file/);
      expect(about("truncated")).toMatch(/the state file is not JSON/);
      expect(about("corrupt-log")).toMatch(/is not JSON/);
      expect(skipped.every((l) => l.endsWith("(left as is)"))).toBe(true);
      expect(notices.some((l) => l.startsWith("restored 1 session"))).toBe(true);
      // A client opening a skipped uid gets a session — in memory only.
      const b = await client(second.url);
      for (const sessionId of ["truncated", "newer", "corrupt-log"]) {
        const opened = await b.request("session/open", { sessionId, messages: seed });
        expect(opened?.result).toMatchObject({ created: true });
        await b.request("session/close", { sessionId });
      }
      b.ws.close();
    } finally {
      await second.stop();
    }
    for (const [id, f] of Object.entries(bad)) {
      expect(await readFile(logPath(id), "utf8")).toBe(f.log);
      expect(await readFile(statePath(id), "utf8")).toBe(f.state);
    }
  });

  test("R10 a record with a non-integer updatedAt is skipped loudly; session/list stays valid for the rest", async () => {
    // Review finding 2. Mutation: drop the integer check in `parseSidecar` → the
    // record loads, its entry carries 1.5 and the list fails the client's schema.
    const first = await serve();
    const a = await client(first.url);
    await a.request("session/open", { sessionId: "good", messages: seed });
    a.ws.close();
    await first.stop();
    const goodLog = await readFile(logPath("good"), "utf8");
    const nl = goodLog.indexOf("\n");
    const header = JSON.parse(goodLog.slice(0, nl)) as Record<string, unknown>;
    await writeFile(
      logPath("bad-stamp"),
      `${JSON.stringify({ ...header, id: "bad-stamp" })}\n${goodLog.slice(nl + 1)}`,
    );
    const badText = JSON.stringify({ ...(await stateOf("good")), id: "bad-stamp", updatedAt: 1.5 });
    await writeFile(statePath("bad-stamp"), badText);

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
      expect(notices.find((l) => l.includes("bad-stamp.jsonl"))).toMatch(
        /^skipped .*"updatedAt" is not a non-negative integer \(left as is\)$/,
      );
      expect(notices.some((l) => l.startsWith("restored 1 session"))).toBe(true);
    } finally {
      await second.stop();
    }
    expect(await readFile(statePath("bad-stamp"), "utf8")).toBe(badText);
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

  test("a session/delete removes that session's spilled tool output (live and archived), not another's; close keeps it", async () => {
    // Mutation: drop `onSessionDeleted` from the daemon's SessionHost → the files stay.
    const first = await serve();
    const sink = toolOutputStore().forProject(config.cwd);
    const live = await sink.write("s-spill-live", "t", "1", "x");
    const arch = await sink.write("s-spill-arch", "t", "1", "x");
    const other = await sink.write("s-spill-other", "t", "1", "x");
    const a = await client(first.url);
    for (const id of ["s-spill-live", "s-spill-arch", "s-spill-other"]) {
      await a.request("session/open", { sessionId: id, messages: seed });
    }
    await a.request("session/close", { sessionId: "s-spill-arch" });
    expect(existsSync(arch ?? "")).toBe(true); // archived keeps its files (a reopen needs them)
    await a.request("session/delete", { sessionId: "s-spill-live" });
    await a.request("session/delete", { sessionId: "s-spill-arch" });
    await until(() => !existsSync(live ?? "") && !existsSync(arch ?? ""));
    expect(existsSync(other ?? "")).toBe(true);
    a.ws.close();
    await first.stop();
  });

  test("a daemon start sweeps spilled files past tools.outputRetentionDays, and keeps them for 0", async () => {
    // Mutation: drop `sweepToolOutput` from `reloadedHost` → the aged file stays.
    const sink = toolOutputStore().forProject(config.cwd);
    const aged = await sink.write("s-aged", "t", "1", "x");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(aged ?? "", old, old);
    const keep = await serve({ ...config, toolOutputRetentionDays: 0 });
    await keep.stop();
    expect(existsSync(aged ?? "")).toBe(true);
    const sweeper = await serve();
    await sweeper.stop();
    await until(() => !existsSync(aged ?? ""));
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
    for (const id of ["s-del", "s-del-arch"]) {
      expect(files).not.toContain(`${id}.jsonl`);
      expect(files).not.toContain(`${id}.state.json`);
    }

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
    expect(await readdir(daemonStoreDir(config))).not.toContain("s-del.jsonl");
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
    const logBytes = await readFile(logPath("s-half"), "utf8");
    const stateBytes = await readFile(statePath("s-half"), "utf8");
    const second = await serve();
    const b = await client(second.url);
    await b.request("session/delete", { sessionId: "s-half" });
    b.ws.close();
    await second.stop();
    // The crash window: the files are back as they were, the tombstone is on disk.
    await writeFile(logPath("s-half"), logBytes);
    await writeFile(statePath("s-half"), stateBytes);
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
    // The interrupted removal is finished: both files.
    const left = await readdir(daemonStoreDir(config));
    expect(left).not.toContain("s-half.jsonl");
    expect(left).not.toContain("s-half.state.json");
  });
});
