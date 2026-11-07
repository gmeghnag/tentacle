import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { currentSegment, headerLine, parseLogFile } from "../src/session-log-file.ts";
import {
  type LogAsideInfo,
  LogSessionStore,
  type LogStoreIo,
  type LogWrite,
} from "../src/session-log-store.ts";
import { FakeLog, FakeReader, META, asst, tool, user } from "./support/log-fixture.ts";

// docs/feat/session-log-laptop-store.md §3: the laptop's `<uid>.jsonl` store —
// APPEND vs REPLACE, the containment/aside rule (F1 on disk), several writers
// under the session lock, torn tails, unknown entries, keepSuperseded, the
// listing, remove, and the in-process snapshot path.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-log-store-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const fresh = (): string => join(dir, `d${++n}`);

/** An io that counts what it writes. */
function countingIo() {
  const counts = { appended: 0, appends: 0, rewritten: 0, rewrites: 0 };
  const io: LogStoreIo = {
    async append(path, data) {
      counts.appended += data.length;
      counts.appends++;
      await appendFile(path, data, { mode: 0o600 });
    },
    async writeDurable(path, data) {
      counts.rewritten += data.length;
      counts.rewrites++;
      await writeFile(path, data, { mode: 0o600 });
    },
  };
  return { io, counts };
}

async function load(store: LogSessionStore, id: string): Promise<readonly ChatMessage[] | string> {
  const result = await store.load(id);
  return result.status === "ok" ? result.record.messages : result.status;
}

async function parse(store: LogSessionStore, id: string) {
  const result = parseLogFile(await readFile(store.file(id), "utf8"), id);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

async function asidesIn(where: string, id: string): Promise<string[]> {
  return (await readdir(where)).filter((f) => f.startsWith(`${id}.stale-`) && f.endsWith(".aside"));
}

describe("APPEND vs REPLACE", () => {
  test("W2 a round on a ~2 MB session appends only its own lines and keeps the inode (no rewrite)", async () => {
    // RED on main (the repro): 2.1 MB rewritten per save, a new inode each time.
    const where = fresh();
    const { io, counts } = countingIo();
    const store = new LogSessionStore(where, { io });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    const big: ChatMessage[] = [user("go")];
    while (JSON.stringify(big).length < 2_000_000) big.push(asst("x".repeat(2000)));
    await store.write(reader.read(log.base(big), "cold"));
    const inode = (await stat(store.file("s"))).ino;
    const before = { ...counts };
    const round = [
      log.turnStart("t1"),
      log.msg(asst("", ["c1"])),
      log.callStarted("c1"),
      log.msg(tool("c1")),
    ];
    const update = reader.read(round);
    await store.write(update);
    const roundBytes = round.map((e) => JSON.stringify(e).length + 1).reduce((a, b) => a + b, 0);
    expect(counts.rewrites).toBe(before.rewrites);
    expect(counts.appended - before.appended).toBe(roundBytes);
    expect((await stat(store.file("s"))).ino).toBe(inode);
    expect(await load(store, "s")).toEqual(cutLoad([...big, asst("", ["c1"]), tool("c1")]));
  });

  test("a write after a FAILED one does not splice: the next save replaces from the writer's segment (FM 8)", async () => {
    const where = fresh();
    let fail = false;
    const store = new LogSessionStore(where, {
      io: {
        append: async (path, data) => {
          if (fail) throw Object.assign(new Error("full"), { code: "ENOSPC" });
          await appendFile(path, data);
        },
        writeDurable: async (path, data) => {
          if (fail) throw Object.assign(new Error("full"), { code: "ENOSPC" });
          await writeFile(path, data);
        },
      },
    });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("a")]), "cold"));
    fail = true;
    await expect(store.write(reader.read([log.msg(asst("b"))]))).rejects.toThrow(/no space left/);
    fail = false;
    await store.write(reader.read([log.msg(user("c"))]));
    expect(await load(store, "s")).toEqual([user("a"), asst("b"), user("c")]);
  });

  test("an empty history writes no file (nothing committed yet); a later read still lands", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read([...log.base([]), log.turnStart("t1")], "cold"));
    expect(await readdir(where)).not.toContain("s.jsonl");
    await store.write(reader.read([log.msg(user("go"))]));
    expect((await parse(store, "s")).segments).toHaveLength(1);
    expect(await load(store, "s")).toEqual([
      user("go"),
      { role: "assistant", content: expect.any(String) },
    ]);
  });

  test("W3 a torn tail: load ignores it; the next append truncates it first, then every line parses", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("a")]), "cold"));
    await appendFile(store.file("s"), '{"type":"message","seq":9');
    expect(await load(store, "s")).toEqual([user("a")]);
    await store.write(reader.read([log.msg(asst("b"))]));
    const text = await readFile(store.file("s"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .split("\n")
        .filter((l) => l !== "")
        .every((l) => JSON.parse(l) !== null),
    ).toBe(true);
    expect((await parse(store, "s")).torn).toBe(0);
    expect(await load(store, "s")).toEqual([user("a"), asst("b")]);
  });
});

describe("F1 on disk: a replace never drops content its copy does not contain", () => {
  test("W5 another incarnation's divergent copy: the file's segment goes aside FIRST (log format), then the new one, with a notice", async () => {
    // RED on main (the repro): the divergent copy replaced 4 messages, asides=0.
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const a = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const d1 = new FakeLog("D1");
    await a.write(
      new FakeReader("s").read(d1.base([user("a"), asst("b"), user("c"), asst("d")]), "cold"),
    );
    const d2 = new FakeLog("D2");
    await a.write(
      new FakeReader("s").read(d2.base([user("a"), asst("b"), user("D2's turn")]), "cold"),
    );
    expect(await load(a, "s")).toEqual([user("a"), asst("b"), user("D2's turn")]);
    expect(asides).toHaveLength(1);
    const kept = parseLogFile(await readFile(asides[0]?.file ?? "", "utf8"), "s");
    expect(kept.ok && currentSegment(kept).messages).toEqual([
      user("a"),
      asst("b"),
      user("c"),
      asst("d"),
    ]);
    expect(await asidesIn(where, "s")).toHaveLength(1);
  });

  test("a contained copy (a resume's seed: the file's projection + the load-time close) replaces with NO aside", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const d1 = new FakeLog("D1");
    const raw = [user("go"), asst("", ["c1"])];
    await store.write(
      new FakeReader("s").read(
        [...d1.base([]), d1.turnStart("t1"), ...raw.map((m) => d1.msg(m))],
        "cold",
      ),
    );
    const loaded = await store.load("s");
    const seed = loaded.status === "ok" ? loaded.record.messages : [];
    expect(seed.length).toBeGreaterThan(raw.length); // closed at load
    await store.write(new FakeReader("s").read(new FakeLog("D2").base(seed, "seed"), "cold"));
    expect(asides).toEqual([]);
    expect(await load(store, "s")).toEqual(seed);
  });

  test("W14 the whole-history path (in-process): one writer's shorter copy replaces; another writer's longer file goes aside", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const rec = (messages: ChatMessage[]): SessionRecord => ({
      id: "s",
      cwd: "/w",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "t",
      messages,
    });
    const mine = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    await mine.saveSnapshot(rec([user("a"), asst("b"), user("c"), asst("d")]));
    await mine.saveSnapshot(rec([user("summary")])); // a compaction by the same writer
    expect(asides).toEqual([]);
    expect(await load(mine, "s")).toEqual([user("summary")]);
    // A resume by another writer: the file is a prefix of its copy → no aside.
    const resumed = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    await resumed.saveSnapshot(rec([user("summary"), asst("more")]));
    expect(asides).toEqual([]);
    // A stale writer (the first one) with a copy that does not contain the file → aside.
    await mine.saveSnapshot(rec([user("stale")]));
    expect(asides).toHaveLength(1);
    expect(await load(mine, "s")).toEqual([user("stale")]);
  });
});

describe("W4 several writers of one session (Q8)", () => {
  test("two stores in this process: the behind one never regresses the file; no duplicate ids", async () => {
    const where = fresh();
    const a = new LogSessionStore(where);
    const b = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const ra = new FakeReader("s");
    const rb = new FakeReader("s");
    const first = log.base([user("go")]);
    await a.write(ra.read(first, "cold"));
    await b.write(rb.read(first, "cold")); // same segment, already there: skip
    const r1 = [log.msg(asst("one"))];
    const r2 = [log.msg(user("two"))];
    await a.write(ra.read(r1));
    await a.write(ra.read(r2));
    await b.write(rb.read(r1)); // B is behind the file: skip, never a regression
    const r3 = [log.msg(asst("three"))];
    await b.write(rb.read([...r2, ...r3].slice(0, 0).concat(r2)));
    await b.write(rb.read(r3)); // B ahead now: appends only what the file lacks
    const file = await parse(a, "s");
    expect(file.duplicates).toBe(0);
    expect(currentSegment(file).messages).toEqual([
      user("go"),
      asst("one"),
      user("two"),
      asst("three"),
    ]);
  });

  test("a second PROCESS interleaving the same reads under the lock: one segment, no duplicates, the full projection", async () => {
    const where = fresh();
    await mkdir(where, { recursive: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    const writes: LogWrite[] = [reader.read(log.base([user("go")]), "cold")];
    for (let i = 0; i < 40; i++)
      writes.push(reader.read([log.msg(i % 2 ? user(`u${i}`) : asst(`a${i}`))]));
    const plan = join(where, "..", `${n}-writes.json`);
    await writeFile(plan, JSON.stringify(writes));
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "fixtures", "log-writer.ts"), where, plan],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const store = new LogSessionStore(where, { lockWaitMs: 10_000 });
    for (const update of writes) {
      await store.write(update);
      await new Promise((r) => setTimeout(r, Math.random() * 3));
    }
    expect((await new Response(child.stdout).text()).trim()).toBe("done");
    await child.exited;
    const file = await parse(store, "s");
    expect(file.duplicates).toBe(0);
    expect(file.segments).toHaveLength(1);
    expect(currentSegment(file).messages).toEqual(reader.messages);
  }, 20_000);

  test("W10 the lock: a live holder is waited for, then the save fails (reported); stale holders are taken over; released on errors", async () => {
    const where = fresh();
    await mkdir(where, { recursive: true });
    const store = new LogSessionStore(where, { lockWaitMs: 80, lockStaleMs: 30_000 });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    const lock = join(where, ".s.lock");
    // A live holder (a real process), fresh stamp.
    const holder = Bun.spawn(["sleep", "5"]);
    await writeFile(lock, `${holder.pid} other ${Date.now()}`);
    const started = Date.now();
    await expect(store.write(reader.read(log.base([user("a")]), "cold"))).rejects.toThrow(
      /another tentacle/,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    // The same holder, but an old stamp (pid reuse) → taken over.
    await writeFile(lock, `${holder.pid} other ${Date.now() - 60_000}`);
    await store.write(reader.read([log.msg(asst("b"))]));
    holder.kill();
    // A dead holder → taken over.
    await writeFile(lock, `999999 other ${Date.now()}`);
    await store.write(reader.read([log.msg(user("c"))]));
    expect(await load(store, "s")).toEqual([user("a"), asst("b"), user("c")]);
    // Released after a FAILED write too.
    await chmod(store.file("s"), 0o400);
    await chmod(where, 0o500);
    await expect(store.write(reader.read([log.msg(asst("d"))]))).rejects.toThrow();
    await chmod(where, 0o700);
    await chmod(store.file("s"), 0o600);
    expect(await readdir(where)).not.toContain(".s.lock");
  });
});

describe("unknown entries and versions (Q2, FM 14/15)", () => {
  test("W9 an unknown non-critical line (a newer build's): skipped at load, kept by an append, set aside by a replace", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("a")]), "cold"));
    const newer = `${JSON.stringify({ type: "usage_total", seq: 90, id: "D1/x", ts: 1, n: 3 })}\n`;
    await appendFile(store.file("s"), newer);
    expect(await load(store, "s")).toEqual([user("a")]);
    await store.write(reader.read([log.msg(asst("b"))]));
    expect(await readFile(store.file("s"), "utf8")).toContain('"usage_total"');
    expect(await load(store, "s")).toEqual([user("a"), asst("b")]);
    expect(asides).toEqual([]);
    // A replace (another incarnation) would drop it: its segment goes aside first.
    await store.write(
      new FakeReader("s").read(new FakeLog("D2").base([user("a"), asst("b")]), "cold"),
    );
    expect(asides).toHaveLength(1);
    expect(await readFile(asides[0]?.file ?? "", "utf8")).toContain('"usage_total"');
    expect(await readFile(store.file("s"), "utf8")).not.toContain('"usage_total"');
  });

  test("W9 an unknown critical entry / an unknown schemaVersion: load refuses; a write sets the bytes aside verbatim, then replaces", async () => {
    for (const bad of [
      (h: string, body: string) =>
        `${h}${body}${JSON.stringify({ type: "edit", seq: 50, id: "D9/50", ts: 1, critical: true })}\n`,
      (_h: string, body: string) =>
        `${JSON.stringify({ format: "tentacle-session-log", schemaVersion: 9, id: "s", cwd: "/w", model: "m", createdAt: 1 })}\n${body}`,
    ]) {
      const where = fresh();
      const asides: LogAsideInfo[] = [];
      const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
      await mkdir(where, { recursive: true });
      const body = new FakeLog("D9")
        .base([user("old")])
        .map((e) => `${JSON.stringify(e)}\n`)
        .join("");
      const original = bad(headerLine({ id: "s", ...META }), body);
      await writeFile(store.file("s"), original);
      expect(await load(store, "s")).toBe("unreadable");
      await store.write(new FakeReader("s").read(new FakeLog("D1").base([user("new")]), "cold"));
      expect(asides).toHaveLength(1);
      expect(await readFile(asides[0]?.file ?? "", "utf8")).toBe(original);
      expect(await load(store, "s")).toEqual([user("new")]);
    }
  });
});

describe("W6 keepSuperseded (compaction, context_reset)", () => {
  for (const keep of [false, true]) {
    test(`keepSuperseded ${keep}: ${keep ? "the old segments stay" : "one segment"}; the projection is the current one either way`, async () => {
      const where = fresh();
      const asides: LogAsideInfo[] = [];
      const store = new LogSessionStore(where, {
        keepSuperseded: keep,
        onAside: (i) => asides.push(i),
      });
      const log = new FakeLog("D1");
      const reader = new FakeReader("s");
      await store.write(reader.read(log.base([user("a"), asst("b")]), "cold"));
      await store.write(
        reader.read([log.msg(user("c")), ...log.base([user("summary")], "compact")]),
      );
      await store.write(
        reader.read([log.msg(asst("d")), ...log.base([user("FRESH")], "context_reset", "t2")]),
      );
      const file = await parse(store, "s");
      expect(file.segments.map((s) => s.base.reason)).toEqual(
        keep ? ["create", "compact", "context_reset"] : ["context_reset"],
      );
      if (keep) {
        // The superseded segments are whole (their tails included).
        expect(file.segments[0]?.messages).toEqual([user("a"), asst("b"), user("c")]);
        expect(file.segments[1]?.messages).toEqual([user("summary"), asst("d")]);
      }
      expect(currentSegment(file).messages).toEqual([user("FRESH")]);
      expect(asides).toEqual([]);
    });
  }

  test("keepSuperseded true, a rebased read (the laptop missed the compaction batch): the old segment is kept, the new one stacked", async () => {
    const where = fresh();
    const store = new LogSessionStore(where, { keepSuperseded: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("a")]), "cold"));
    log.msg(asst("missed")); // the laptop never read this one
    const compacted = log.base([user("summary")], "compact");
    await store.write(reader.read(compacted, "cold")); // a rebased read: from the base
    const file = await parse(store, "s");
    expect(file.segments.map((s) => s.base.reason)).toEqual(["create", "compact"]);
    expect(currentSegment(file).messages).toEqual([user("summary")]);
  });
});

describe("listing, legacy files, remove", () => {
  test("W11 summarize = load (id, title, updatedAt = mtime, message count); newest first by mtime; a legacy .json is ignored silently", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    for (const [id, at] of [
      ["aaa-old", 1_000_000],
      ["zzz-new", 2_000_000],
    ] as const) {
      const log = new FakeLog(`D-${id}`);
      await store.write(
        new FakeReader(id).read(
          [
            ...log.base([{ role: "system", content: "sys" }, user(`hi ${id}`)]),
            log.title("Chosen", "user"),
            log.turnStart("t"),
            log.msg(asst("", ["c1"])),
          ],
          "cold",
        ),
      );
      await utimes(store.file(id), new Date(at), new Date(at));
    }
    await writeFile(join(where, "legacy.json"), JSON.stringify({ id: "legacy", messages: [] }));
    const { records, skipped } = await store.list();
    expect(records.map((r) => r.id)).toEqual(["zzz-new", "aaa-old"]);
    expect(skipped).toEqual([]);
    for (const summary of records) {
      const full = await store.load(summary.id);
      const record = full.status === "ok" ? full.record : null;
      expect(summary.updatedAt).toBe(record?.updatedAt ?? -1);
      expect(summary.title).toEqual(record?.title ?? "");
      expect(summary.messageCount).toBe(
        record?.messages.filter((m) => m.role !== "system").length ?? -1,
      );
    }
    expect(records[0]?.title).toEqual({ text: "Chosen", source: "user" });
    expect(await store.load("legacy")).toEqual({ status: "absent" });
  });

  test("W13 remove deletes the log and its asides (exact names, never a twin id's), under the lock", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    await store.write(new FakeReader("s").read(new FakeLog("D1").base([user("a")]), "cold"));
    await store.write(new FakeReader("s").read(new FakeLog("D2").base([user("b")]), "cold")); // → an aside
    const twin = "s.stale-1-deadbeef";
    await store.write(new FakeReader(twin).read(new FakeLog("T1").base([user("x")]), "cold"));
    expect(await asidesIn(where, "s")).toHaveLength(1);
    await store.remove("s");
    const left = await readdir(where);
    expect(
      left.filter((f) => f === "s.jsonl" || /^s\.stale-\d+-[0-9a-f]{8}\.aside$/.test(f)),
    ).toEqual([]);
    expect(left).toContain(`${twin}.jsonl`);
    expect(left.filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  test("a fork's held copy goes aside once (saveAside), and the replace that follows does not set it aside again", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const reader = new FakeReader("s");
    await store.write(reader.read(new FakeLog("D1").base([user("mine")]), "cold"));
    const file = await store.saveAside("s", META, reader.messages, { source: "auto" });
    await store.write(reader.read(new FakeLog("D2").base([user("theirs")]), "fork"));
    expect(asides).toEqual([]);
    expect(await asidesIn(where, "s")).toEqual([file.slice(where.length + 1)]);
    expect(await load(store, "s")).toEqual([user("theirs")]);
  });
});

/** What a load gives for `messages` ending in an open turn's unanswered state (closed). */
function cutLoad(messages: ChatMessage[]): ChatMessage[] {
  return [...messages, { role: "assistant", content: expect.any(String) as unknown as string }];
}
