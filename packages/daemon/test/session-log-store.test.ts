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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { SessionBlobs } from "../src/session-blobs.ts";
import { forkWrite } from "../src/session-fork.ts";
import { currentSegment, headerLine, parseLogFile } from "../src/session-log-file.ts";
import {
  ForkWriteError,
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

  // docs/feat/session-log-serve-store.md Q11: a base that explicitly continues
  // the file's last entry (`prev` = its id: `serve`'s reload) restates that segment.
  test("S10 a base continuing the file's last entry is contained (no aside), even with in-place changes after it", async () => {
    // Mutation: drop the `prev` clause in `settleLast` → the reload's restatement + an
    // in-place repair is not a prefix → a useless aside at every restart.
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const d1 = new FakeLog("D1");
    const first = [user("go"), asst("", ["c1"]), tool("c1")];
    const r1 = new FakeReader("s");
    await store.write(r1.read(d1.base(first), "cold"));
    // The reload: base{reload, prev = the file's last id} restating `first`, then the
    // repair rewrites message 2 in place (an overlay) — the projection is not a prefix extension.
    const d2 = new FakeLog("D2", r1.head);
    const reload = [...d2.base(first, "reload"), d2.replace(2, tool("c1", "annotated"))];
    await new LogSessionStore(where, { onAside: (i) => asides.push(i) }).write(
      new FakeReader("s").read(reload, "cold"),
    );
    expect(asides).toEqual([]);
    expect(await load(store, "s")).toEqual([user("go"), asst("", ["c1"]), tool("c1", "annotated")]);
  });

  test("S10 an entry after the continued one (a unit that never landed) → exactly that content goes aside", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const d1 = new FakeLog("D1");
    const r1 = new FakeReader("s");
    await store.write(r1.read(d1.base([user("go")]), "cold"));
    const landed = r1.head; // what the state file named
    await store.write(r1.read([d1.msg(asst("never landed"))])); // the log ahead of its state file
    const d2 = new FakeLog("D2", landed);
    await new LogSessionStore(where, { onAside: (i) => asides.push(i) }).write(
      new FakeReader("s").read([...d2.base([user("go")], "reload"), d2.msg(user("note"))], "cold"),
    );
    expect(asides).toHaveLength(1);
    const kept = parseLogFile(await readFile(asides[0]?.file ?? "", "utf8"), "s");
    expect(kept.ok && currentSegment(kept).messages).toEqual([user("go"), asst("never landed")]);
    expect(await load(store, "s")).toEqual([user("go"), user("note")]);
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

// Fix round 1 (docs/feat/session-log-laptop-store.md "### Fix round 1"): the review's
// M1 / M2 / L1 / L3 — "never silently lost" on the several-writers, forward-compat and
// kept-history paths.
describe("fix round 1", () => {
  for (const keep of [false, true]) {
    test(`M1 keepSuperseded ${keep}: an OLDER writer of the same daemon landing after a compaction save never regresses the file (no aside)`, async () => {
      // RED on e1af680: B's older save replaced the post-compaction file ("first prompt").
      const where = fresh();
      const asides: LogAsideInfo[] = [];
      const opts = { keepSuperseded: keep, onAside: (i: LogAsideInfo) => asides.push(i) };
      const a = new LogSessionStore(where, opts);
      const b = new LogSessionStore(where, opts);
      const log = new FakeLog("D1");
      const ra = new FakeReader("s");
      const rb = new FakeReader("s");
      const first = log.base([user("first prompt")]);
      await a.write(ra.read(first, "cold"));
      await b.write(rb.read(first, "cold"));
      const round = [log.msg(asst("first answer"))];
      const compaction = [
        ...log.base([user("SUMMARY")], "compact"),
        log.msg(user("prompt AFTER compaction")),
      ];
      await a.write(ra.read([...round, ...compaction])); // A is ahead: the compaction is in
      await b.write(rb.read(round)); // B's OLDER read lands last
      expect(await load(a, "s")).toEqual([user("SUMMARY"), user("prompt AFTER compaction")]);
      expect(asides).toEqual([]);
      const file = await parse(a, "s");
      expect(file.segments.map((s) => s.base.reason)).toEqual(
        keep ? ["create", "compact"] : ["compact"],
      );
      expect(file.duplicates).toBe(0);
    });
  }

  test("M2 a torn tail after an unknown non-critical last line, with NON-ASCII content: the append truncates at the right BYTE", async () => {
    // RED on e1af680: truncated at a char offset → the newer build's line was cut in half.
    const where = fresh();
    await mkdir(where, { recursive: true });
    const store = new LogSessionStore(where);
    const log = new FakeLog("A");
    const accented = user("perché è così? ".repeat(20));
    const entries = log.base([accented]);
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const future = { type: "future_note", seq: 9, id: "A/x", ts: 1, note: "newer build" };
    await writeFile(
      store.file("s"),
      `${
        headerLine({ id: "s", ...META }) + entries.map(line).join("") + line(future)
      }{"type":"message","seq":3,"id":"to`,
    );
    const reader = new FakeReader("s");
    await store.write(reader.read([...entries, log.msg(asst("ok"))], "cold"));
    const file = await parse(store, "s"); // refused (a half line) before the fix
    expect(file.torn).toBe(0);
    expect(file.skipped).toBe(1); // the newer build's line is kept
    expect(currentSegment(file).messages).toEqual([accented, asst("ok")]);
    expect(await asidesIn(where, "s")).toEqual([]);
  });

  test("L3 segments already kept (keepSuperseded true) survive a later replace with the option OFF", async () => {
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const kept = new LogSessionStore(where, { keepSuperseded: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await kept.write(reader.read(log.base([user("a"), asst("b")]), "cold"));
    await kept.write(reader.read(log.base([user("summary")], "compact")));
    expect((await parse(kept, "s")).segments).toHaveLength(2);
    // Another run, option off: a reseed (a restatement, contained) replaces the last segment.
    const off = new LogSessionStore(where, {
      keepSuperseded: false,
      onAside: (i) => asides.push(i),
    });
    await off.write(
      new FakeReader("s").read(
        new FakeLog("D2").base([user("summary"), asst("more")], "seed"),
        "cold",
      ),
    );
    const file = await parse(off, "s");
    expect(file.segments.map((s) => s.base.reason)).toEqual(["create", "seed"]);
    expect(file.segments[0]?.messages).toEqual([user("a"), asst("b")]);
    expect(asides).toEqual([]);
    // …and a compaction rewrite with the option off keeps them too.
    const r2 = new FakeReader("s");
    const d3 = new FakeLog("D3");
    await off.write(r2.read(d3.base([user("summary"), asst("more")], "seed"), "cold"));
    await off.write(r2.read(d3.base([user("S2")], "compact")));
    const after = await parse(off, "s");
    expect(after.segments.map((s) => s.base.reason)).toEqual(["create", "compact"]);
    expect(after.segments[0]?.messages).toEqual([user("a"), asst("b")]);
  });

  test("L3 an in-process saveSnapshot carries the kept segments over", async () => {
    const where = fresh();
    const kept = new LogSessionStore(where, { keepSuperseded: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await kept.write(reader.read(log.base([user("a"), asst("b")]), "cold"));
    await kept.write(reader.read(log.base([user("summary")], "compact")));
    const snap = new LogSessionStore(where);
    await snap.saveSnapshot({
      id: "s",
      cwd: "/w",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "t",
      messages: [user("summary"), asst("more")],
    });
    const file = await parse(snap, "s");
    expect(file.segments).toHaveLength(2);
    expect(file.segments[0]?.messages).toEqual([user("a"), asst("b")]);
    expect(currentSegment(file).messages).toEqual([user("summary"), asst("more")]);
  });

  test("L3 the continuing compaction rewrite (option off) sets aside the unknown lines of the segment it supersedes", async () => {
    // RED on e1af680: the fast path rewrote the file without reading it → the line was dropped.
    const where = fresh();
    const asides: LogAsideInfo[] = [];
    const store = new LogSessionStore(where, { onAside: (i) => asides.push(i) });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("a")]), "cold"));
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const future = { type: "usage_total", seq: 90, id: "D1/x", ts: 1, n: 3 };
    const next = log.msg(asst("b"));
    // Another writer's lines: an unknown one (a newer build), then the known one this reader holds.
    await appendFile(store.file("s"), line(future) + line(next));
    reader.read([next]); // this reader's head is `next`, which is the file's last line
    await store.write(reader.read(log.base([user("summary")], "compact")));
    expect(asides).toHaveLength(1);
    expect(await readFile(asides[0]?.file ?? "", "utf8")).toContain('"usage_total"');
    expect(await load(store, "s")).toEqual([user("summary")]);
    expect(await readFile(store.file("s"), "utf8")).not.toContain('"usage_total"');
  });

  test("L1 an empty or unparsable lock body counts as LIVE until the lock's mtime is older than lockStaleMs", async () => {
    // RED on e1af680: an empty body (a holder between open(wx) and writeFile) read as stale → taken.
    for (const body of ["", "garbage"]) {
      const where = fresh();
      await mkdir(where, { recursive: true });
      const store = new LogSessionStore(where, { lockWaitMs: 80, lockStaleMs: 30_000 });
      const log = new FakeLog("D1");
      const reader = new FakeReader("s");
      const lock = join(where, ".s.lock");
      await writeFile(lock, body);
      await expect(store.write(reader.read(log.base([user("a")]), "cold"))).rejects.toThrow(
        /another tentacle/,
      );
      expect(await readFile(lock, "utf8")).toBe(body); // left alone
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      await store.write(reader.read([log.msg(asst("b"))]));
      expect(await load(store, "s")).toEqual([user("a"), asst("b")]);
    }
  });
});

/** What a load gives for `messages` ending in an open turn's unanswered state (closed). */
function cutLoad(messages: ChatMessage[]): ChatMessage[] {
  return [...messages, { role: "assistant", content: expect.any(String) as unknown as string }];
}

describe("the sub-agent load derivation on the laptop's load (docs/feat/subagent-ledger-log.md)", () => {
  test("an open `bg` becomes the lost note at load; loading twice gives ONE note each time and writes nothing", async () => {
    // RED on main: `load()` returns the file's projection as it is — a child a
    // restart killed is invisible to the resumed model (eval A4, Finding 2).
    // Mutation: derive from ALL segments (not the current one) → the
    // superseded-segment case below goes red; skipping the derivation → this.
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    await store.write(reader.read([log.subagentBackground("sa-1")]));

    const before = await readFile(store.file("s"), "utf8");
    const first = await load(store, "s");
    if (typeof first === "string") throw new Error(first);
    expect(first.map((m) => m.role)).toEqual(["user", "user"]);
    expect(first[1]?.note).toEqual({ kind: "subagent_lost", id: "sa-1" });
    expect(first[1]?.content).toContain("sa-1 (map the repo) was lost");
    // The LOAD writes nothing: the same bytes, and the same notes again.
    expect(await readFile(store.file("s"), "utf8")).toBe(before);
    const second = await load(store, "s");
    if (typeof second === "string") throw new Error(second);
    expect(second).toEqual(first);
  });

  test("a note already in the history closes its id: no second note (idempotent across a save)", async () => {
    // Mutation: `subagentLoadNotes` without the `noteSeen` pass → every load
    // notes the child again (and every save adds one more) → red.
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    const ended = {
      role: "user" as const,
      content: "[background] sub-agent sa-1 finished",
      note: { kind: "subagent_report", id: "sa-1" },
    };
    await store.write(reader.read(log.base([user("go"), ended]), "cold"));
    await store.write(reader.read([log.subagentBackground("sa-1"), log.subagentEnd("sa-1", "R")]));
    const messages = await load(store, "s");
    if (typeof messages === "string") throw new Error(messages);
    expect(messages).toEqual([user("go"), ended]);
  });

  test("an open `bg` in a SUPERSEDED segment only: no note (only the current segment is derived, F14)", async () => {
    // Mutation: fold every segment the file keeps (keepSuperseded) → a child the
    // new segment deliberately dropped (a /clear, a fresh start) is revived → red.
    const where = fresh();
    const store = new LogSessionStore(where, { keepSuperseded: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    await store.write(reader.read([log.subagentBackground("sa-1")]));
    // A compaction whose summary drops everything: a new segment, no marker.
    await store.write(reader.read(log.base([user("SUMMARY")], "compact"), "fork"));
    const messages = await load(store, "s");
    if (typeof messages === "string") throw new Error(messages);
    expect(messages).toEqual([user("SUMMARY")]);
    // Both segments are on disk (the old one still holds the marker).
    const parsed = await parse(store, "s");
    expect(parsed.segments).toHaveLength(2);
  });

  test("an open turn's repair comes first, then the lost note (both are appended, order kept)", async () => {
    // FM 1: a crash between the marker and the tool result. Mutation: append the
    // notes BEFORE the closed turn → the history ends on a cut-turn note while a
    // child is still open → red.
    const where = fresh();
    const store = new LogSessionStore(where);
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    await store.write(
      reader.read([
        log.turnStart("t1"),
        log.callStarted("c1"),
        log.subagentBackground("sa-1", "c1"),
        log.msg(asst("", ["c1"])),
      ]),
    );
    const messages = await load(store, "s");
    if (typeof messages === "string") throw new Error(messages);
    // The cut turn's own repair (an answer to c1 + the ended-turn note), THEN the lost note.
    const last = messages.at(-1);
    expect(last?.note).toEqual({ kind: "subagent_lost", id: "sa-1" });
    const repair = messages.slice(0, -1);
    expect(repair[1]?.toolCalls?.[0]?.id).toBe("c1");
    expect(repair.map((m) => m.content).join(" ")).toMatch(/interrupted/i);
    expect(repair.every((m) => m.note === undefined)).toBe(true);
  });
});

describe("fork (docs/feat/clear-fork-history.md): a NEW session holding the chat a source is about to drop", () => {
  const OLD = [user("the OLD chat"), asst("old reply")];
  const forkOf = (id: string, messages: readonly ChatMessage[] = OLD): LogWrite =>
    forkWrite({ id, meta: META, messages, title: { source: "model", text: "old title" }, ts: 5 });

  /** An io whose `writeDurable` fails, or waits, for the fork's temp only. */
  function forkIo(forkId: string) {
    const control = {
      fail: false,
      gate: null as Promise<void> | null,
      forkTemps: 0,
    };
    const io: LogStoreIo = {
      append: async (path, data) => {
        await appendFile(path, data, { mode: 0o600 });
      },
      writeDurable: async (path, data) => {
        if (path.includes(forkId)) {
          control.forkTemps++;
          if (control.gate) await control.gate;
          if (control.fail) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        }
        await writeFile(path, data, { mode: 0o600 });
      },
    };
    return { io, control };
  }

  /** The source "s" holds the old chat; the reader then restarts at a new base (the clear). */
  async function sourceWithOldChat(store: LogSessionStore) {
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base(OLD), "cold"));
    const cleared = new FakeLog("D2");
    return { cleared, reader };
  }

  test("T3 a new listed session; the source's bytes are untouched; no writer is left for the fork", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    await sourceWithOldChat(store);
    const before = await readFile(store.file("s"), "utf8");
    const writers = store.residentWriters();
    await store.fork("s", forkOf("f1"));
    expect(await readFile(store.file("s"), "utf8")).toBe(before);
    expect(store.residentWriters()).toBe(writers);
    const listed = (await store.list()).records.map((r) => r.id).sort();
    expect(listed).toEqual(["f1", "s"]);
    expect(await load(store, "f1")).toEqual(OLD);
    expect(await readdir(where)).not.toContain(".f1.lock");
  });

  test("T4 the fork precedes the source's next write: the source file is not touched until the fork lands", async () => {
    const where = fresh();
    const { io, control } = forkIo("f1");
    const store = new LogSessionStore(where, { io });
    const { cleared, reader } = await sourceWithOldChat(store);
    const before = await readFile(store.file("s"), "utf8");
    const gate = Promise.withResolvers<void>();
    control.gate = gate.promise;
    const forking = store.fork("s", forkOf("f1"));
    const saving = store.write(reader.read(cleared.base([user("fresh")]), "cold"));
    await Bun.sleep(60);
    expect(control.forkTemps).toBe(1);
    expect(await readFile(store.file("s"), "utf8")).toBe(before);
    gate.resolve();
    await forking;
    await saving;
    expect(await load(store, "f1")).toEqual(OLD);
    expect(await load(store, "s")).toEqual([user("fresh")]);
  });

  test("T5 a failed fork blocks the source's replace, then heals: the old chat is never dropped before it is durable", async () => {
    const where = fresh();
    const { io, control } = forkIo("f1");
    const store = new LogSessionStore(where, { io });
    const { cleared, reader } = await sourceWithOldChat(store);
    const before = await readFile(store.file("s"), "utf8");
    control.fail = true;
    await expect(store.fork("s", forkOf("f1"))).rejects.toThrow(/could not be kept/);
    const replace = reader.read(cleared.base([user("fresh")]), "cold");
    await expect(store.write(replace)).rejects.toBeInstanceOf(ForkWriteError);
    expect(await readFile(store.file("s"), "utf8")).toBe(before);
    expect(await readdir(where)).not.toContain("f1.jsonl");
    control.fail = false;
    await store.write(replace);
    expect(await load(store, "f1")).toEqual(OLD);
    expect(await load(store, "s")).toEqual([user("fresh")]);
    // Healed: the next write does not re-write the fork.
    const temps = control.forkTemps;
    await store.write(reader.read([cleared.msg(asst("again"))]));
    expect(control.forkTemps).toBe(temps);
  });

  test("M2 the fork's sidecar is written AFTER its log: a failed log write leaves no state file", async () => {
    // AGENTS §7: a sidecar names a log entry, so writing it first would let a
    // crash leave a state file naming an entry the log does not have. Red under
    // the mutation `writeStateLocked` before `writeLocked` in `writeFork`.
    const where = fresh();
    const failing = "f1.jsonl";
    const io: LogStoreIo = {
      append: async (path, data) => {
        await appendFile(path, data, { mode: 0o600 });
      },
      writeDurable: async (path, data) => {
        if (path.includes(failing)) {
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        }
        await writeFile(path, data, { mode: 0o600 });
      },
    };
    const store = new LogSessionStore(where, { io });
    await sourceWithOldChat(store);
    const update = { ...forkOf("f1"), sidecar: '{"any":"state"}' };
    await expect(store.fork("s", update)).rejects.toBeInstanceOf(ForkWriteError);
    expect(await readdir(where)).not.toContain("f1.state.json");
  });

  test("R2-M2 a log whose sidecar failed still goes through: the source's next write heals the fork", async () => {
    // `landed` skips a fork whose log already exists — EXCEPT when a sidecar is
    // expected and missing (its write failed): that one must be retried, or
    // `serve` (which indexes from `.state.json`) never lists the fork after a
    // restart. Red under the mutation "`landed` returns true as soon as the log
    // exists": the retry is skipped and the sidecar never appears.
    const where = fresh();
    let failSidecar = true;
    const io: LogStoreIo = {
      append: async (path, data) => {
        await appendFile(path, data, { mode: 0o600 });
      },
      writeDurable: async (path, data) => {
        if (failSidecar && path.includes("f1.state.json")) {
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        }
        await writeFile(path, data, { mode: 0o600 });
      },
    };
    const store = new LogSessionStore(where, { io });
    const { cleared, reader } = await sourceWithOldChat(store);
    const state = '{"any":"state"}';
    await expect(store.fork("s", { ...forkOf("f1"), sidecar: state })).rejects.toBeInstanceOf(
      ForkWriteError,
    );
    // The log landed, its sidecar did not; the fork stays pending on its source.
    expect(await readdir(where)).toContain("f1.jsonl");
    expect(await readdir(where)).not.toContain("f1.state.json");
    failSidecar = false;
    await store.write(reader.read(cleared.base([user("fresh")]), "cold"));
    expect(await readdir(where)).toContain("f1.state.json");
    expect(await readFile(store.stateFile("f1"), "utf8")).toBe(state);
    expect(await load(store, "f1")).toEqual(OLD);
  });

  test("T6 a retry of the same fork update is idempotent: one file, identical bytes", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    await sourceWithOldChat(store);
    const update = forkOf("f1");
    await store.fork("s", update);
    const first = await readFile(store.file("f1"), "utf8");
    await store.fork("s", update);
    expect(await readFile(store.file("f1"), "utf8")).toBe(first);
    expect((await readdir(where)).filter((f) => f.startsWith("f1"))).toEqual(["f1.jsonl"]);
  });

  test("T7 the fork holds its own lock: a live holder fails it, no file", async () => {
    const where = fresh();
    await mkdir(where, { recursive: true });
    const store = new LogSessionStore(where, { lockWaitMs: 40, lockStaleMs: 30_000 });
    const holder = Bun.spawn(["sleep", "5"]);
    try {
      await writeFile(join(where, ".f1.lock"), `${holder.pid} other ${Date.now()}`);
      await expect(store.fork("s", forkOf("f1"))).rejects.toBeInstanceOf(ForkWriteError);
      expect(await readdir(where)).not.toContain("f1.jsonl");
    } finally {
      holder.kill();
    }
  });

  test("T8 ForkWriteError names the fork's file", async () => {
    const where = fresh();
    const { io, control } = forkIo("f1");
    const store = new LogSessionStore(where, { io });
    control.fail = true;
    const error = await store.fork("s", forkOf("f1")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ForkWriteError);
    expect((error as Error).message).toContain("could not be kept");
    expect((error as Error).message).toContain(store.file("f1"));
    expect((error as Error).message).toContain("no space left");
  });

  test("an invalid fork id is refused, nothing is written", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    await expect(store.fork("s", forkOf("../evil"))).rejects.toBeInstanceOf(ForkWriteError);
    expect(await readdir(where).catch(() => [])).toEqual([]);
  });
});

describe("image blobs beside the log (docs/feat/attachments-durable.md T2)", () => {
  const same = (got: Uint8Array | null, want: Uint8Array): boolean =>
    got !== null && Buffer.compare(got, want) === 0;
  const png = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const id = createHash("sha256").update(bytes).digest("hex");
    return { bytes, ref: { id, mimeType: "image/png", size: bytes.length, name: `${text}.png` } };
  };

  /** A `SessionBlobs` that records, at each mutation, what the folder held. */
  class SpyBlobs extends SessionBlobs {
    readonly seen: string[] = [];
    constructor(private readonly where: string) {
      super(where);
    }
    private async files(): Promise<string[]> {
      return readdir(this.where).catch(() => []);
    }
    override async write(uid: string, id: string, bytes: Uint8Array): Promise<void> {
      const f = await this.files();
      this.seen.push(`write locked=${f.includes(`.${uid}.lock`)}`);
      return super.write(uid, id, bytes);
    }
    override async removeAll(uid: string): Promise<void> {
      const f = await this.files();
      this.seen.push(
        `removeAll locked=${f.includes(`.${uid}.lock`)} log=${f.includes(`${uid}.jsonl`)} state=${f.includes(`${uid}.state.json`)}`,
      );
      return super.removeAll(uid);
    }
    override async link(from: string, to: string, ids: Iterable<string>): Promise<void> {
      const f = await this.files();
      const list = [...ids].sort();
      this.seen.push(
        `link ${from}->${to} [${list.join(",")}] locked=${f.includes(`.${to}.lock`)} log=${f.includes(`${to}.jsonl`)}`,
      );
      return super.link(from, to, list);
    }
  }

  test("putBlob lands under the session's lock; readBlob/blobIndex read it back", async () => {
    const where = fresh();
    const blobs = new SpyBlobs(where);
    const store = new LogSessionStore(where, { blobs });
    const a = png("a");
    await store.putBlob("s", a.ref.id, a.bytes);
    expect(blobs.seen).toEqual(["write locked=true"]);
    expect(store.blobIndex("s")).toEqual(new Map([[a.ref.id, a.bytes.length]]));
    const got = await store.readBlob("s", a.ref.id);
    expect(same(got, a.bytes)).toBe(true);
    expect(await readdir(where)).not.toContain(".s.lock");
  });

  test("remove deletes <uid>.attachments AFTER the state file and the log, under the lock", async () => {
    const where = fresh();
    const blobs = new SpyBlobs(where);
    const store = new LogSessionStore(where, { blobs });
    const a = png("r");
    await store.write({
      ...new FakeReader("s").read(new FakeLog("D1").base([user("a")]), "cold"),
      sidecar: "{}",
    });
    await store.putBlob("s", a.ref.id, a.bytes);
    await store.remove("s");
    expect(blobs.seen.at(-1)).toBe("removeAll locked=true log=false state=false");
    expect(await readdir(where)).toEqual([]);
  });

  test("fork links exactly the unit's image ids from the source, after the fork's log, under its lock", async () => {
    const where = fresh();
    const blobs = new SpyBlobs(where);
    const store = new LogSessionStore(where, { blobs });
    const a = png("in-fork");
    const b = png("also-in-fork");
    const c = png("source-only");
    for (const x of [a, b, c]) await store.putBlob("s", x.ref.id, x.bytes);
    const messages: ChatMessage[] = [
      { role: "user", content: "look", attachments: [a.ref, b.ref] },
      asst("ok"),
      { role: "user", content: "again", attachments: [a.ref] },
    ];
    await store.fork(
      "s",
      forkWrite({ id: "f1", meta: META, messages, title: { source: "auto" }, ts: 5 }),
    );
    const ids = [a.ref.id, b.ref.id].sort().join(",");
    expect(blobs.seen.at(-1)).toBe(`link s->f1 [${ids}] locked=true log=true`);
    expect([...store.blobIndex("f1").keys()].sort()).toEqual([a.ref.id, b.ref.id].sort());
    // Deleting the source keeps the fork's bytes.
    await store.remove("s");
    const got = await store.readBlob("f1", a.ref.id);
    expect(same(got, a.bytes)).toBe(true);
  });

  test("a fork with no images links nothing", async () => {
    const where = fresh();
    const blobs = new SpyBlobs(where);
    const store = new LogSessionStore(where, { blobs });
    await store.fork(
      "s",
      forkWrite({
        id: "f1",
        meta: META,
        messages: [user("x"), asst("y")],
        title: { source: "auto" },
        ts: 5,
      }),
    );
    expect(blobs.seen.filter((s) => s.startsWith("link"))).toEqual([]);
    expect(await readdir(where)).not.toContain("f1.attachments");
  });

  test("every scan ignores a blob dir: a store holding only one lists nothing", async () => {
    const where = fresh();
    const store = new LogSessionStore(where);
    const a = png("only");
    await store.putBlob("lonely", a.ref.id, a.bytes);
    expect(await readdir(where)).toContain("lonely.attachments");
    expect(await store.list()).toEqual({ records: [], skipped: [] });
    expect(await store.loadAll()).toEqual({ records: [], skipped: [] });
    expect(await store.daemonFiles()).toEqual({ logs: [], orphanStates: [] });
    expect(await store.blobOrphans()).toEqual(["lonely"]);
  });
});
