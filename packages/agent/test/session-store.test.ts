import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@tentacle/core";
import {
  JsonSessionStore,
  type SessionRecord,
  parseSessionRecord,
  projectKey,
  recordFromSnapshot,
  sessionTitle,
} from "../src/index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-sessions-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const messages = (text: string): ChatMessage[] => [
  { role: "user", content: text },
  { role: "assistant", content: "ok" },
];

describe("sessionTitle", () => {
  test("uses the first user message, collapsed and trimmed", () => {
    expect(sessionTitle([{ role: "user", content: "  hello\n  world  " }])).toBe("hello world");
    expect(sessionTitle([{ role: "assistant", content: "x" }])).toBe("(empty)");
    expect(sessionTitle([{ role: "user", content: "a".repeat(200) }]).length).toBe(80);
  });
});

describe("recordFromSnapshot", () => {
  test("carries metadata and derives the title; preserves createdAt", () => {
    const rec = recordFromSnapshot(
      { id: "s1", messages: messages("do a thing") },
      { cwd: "/work", model: "qwen3", createdAt: 1000 },
    );
    expect(rec).toMatchObject({ id: "s1", cwd: "/work", model: "qwen3", createdAt: 1000 });
    expect(rec.title).toBe("do a thing");
    expect(rec.updatedAt).toBeGreaterThanOrEqual(1000);
  });
});

describe("JsonSessionStore", () => {
  test("save → load round-trips a record", async () => {
    const store = new JsonSessionStore(dir);
    const rec = recordFromSnapshot(
      { id: "round", messages: messages("hi") },
      {
        cwd: "/w",
        model: "m",
      },
    );
    await store.save(rec);
    const loaded = await store.load("round");
    expect(loaded).toEqual({ status: "ok", record: rec });
  });

  test("load reports an unknown id as absent", async () => {
    expect(await new JsonSessionStore(dir).load("nope")).toEqual({ status: "absent" });
  });

  test("list is newest-updated first; latest() is its head", async () => {
    const store = new JsonSessionStore(join(dir, "multi"));
    await store.save(
      recordFromSnapshot(
        { id: "old", messages: messages("old") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );
    await store.save(
      recordFromSnapshot(
        { id: "new", messages: messages("new") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );
    // Force a strictly-greater updatedAt on "new" by re-saving it.
    await Bun.sleep(2);
    await store.save(
      recordFromSnapshot(
        { id: "new", messages: messages("new") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );

    const list = await store.list();
    expect(list.records.map((r) => r.id)).toEqual(["new", "old"]);
    expect((await store.latest()).record?.id).toBe("new");
  });

  test("scan yields every .json file once, one at a time, unreadable ones included", async () => {
    const d = join(dir, "scan");
    const store = new JsonSessionStore(d);
    await store.save(
      recordFromSnapshot({ id: "a", messages: messages("a") }, { cwd: "/w", model: "m" }),
    );
    await store.save(
      recordFromSnapshot({ id: "b", messages: messages("b") }, { cwd: "/w", model: "m" }),
    );
    await writeFile(join(d, "bad.json"), "{nope");
    await writeFile(join(d, "notes.txt"), "not a session");
    const scan = (
      store as unknown as { scan?: () => AsyncIterable<{ id: string; result: { status: string } }> }
    ).scan;
    const seen: [string, string][] = [];
    for await (const { id, result } of scan?.call(store) ?? []) {
      seen.push([id, result.status]);
    }
    expect(seen.sort()).toEqual([
      ["a", "ok"],
      ["b", "ok"],
      ["bad", "unreadable"],
    ]);
    // `list` is built on it: same records, same skipped file.
    const listed = await store.list();
    expect(listed.records.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(listed.skipped.map((s) => s.id)).toEqual(["bad"]);
  });

  test("scan of a missing directory yields nothing", async () => {
    const store = new JsonSessionStore(join(dir, "scan-missing"));
    const scan = (store as unknown as { scan?: () => AsyncIterable<unknown> }).scan;
    const seen: unknown[] = [];
    for await (const item of scan?.call(store) ?? [1]) {
      seen.push(item);
    }
    expect(seen).toEqual([]);
  });

  test("list/latest tolerate a missing directory", async () => {
    const store = new JsonSessionStore(join(dir, "does-not-exist"));
    expect(await store.list()).toEqual({ records: [], skipped: [] });
    expect(await store.latest()).toEqual({ record: null, skipped: [] });
  });
});

const rec = (id: string, updatedAt: number, n = 2): SessionRecord => ({
  id,
  cwd: "/w",
  model: "m",
  createdAt: 1,
  updatedAt,
  title: id,
  messages: Array.from({ length: n }, (_, i) => ({
    role: "user" as const,
    content: `m${i} ${"x".repeat(50)}`,
  })),
});

/** A `writeDurable` whose writes block until released, counting each one. */
function gatedIo() {
  const written: number[] = [];
  const gates: Array<() => void> = [];
  let failNext: Error | null = null;
  return {
    written,
    pending: () => gates.length,
    release: () => gates.shift()?.(),
    failNextWith: (error: Error) => {
      failNext = error;
    },
    io: {
      writeDurable: async (path: string, data: string): Promise<void> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        if (failNext) {
          const error = failNext;
          failNext = null;
          throw error;
        }
        written.push(JSON.parse(data).updatedAt);
        await writeFile(path, data);
      },
    },
  };
}

describe("JsonSessionStore durability", () => {
  test("a truncated newest file is reported, not silently replaced by an older session", async () => {
    const d = join(dir, "truncated");
    const store = new JsonSessionStore(d);
    await store.save(rec("old", 1000));
    await store.save(rec("newest", 3000));
    const file = join(d, "newest.json");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.slice(0, text.length / 2));

    expect((await store.load("newest")).status).toBe("unreadable");
    const latest = await store.latest();
    expect(latest.record?.id).toBe("old");
    expect(latest.skipped.map((s) => s.id)).toEqual(["newest"]);
  });

  test("a schema-less file is skipped with a reason and never becomes latest()", async () => {
    const d = join(dir, "schemaless");
    const store = new JsonSessionStore(d);
    await store.save(rec("good", 5000));
    await writeFile(join(d, "zzz.json"), JSON.stringify({ id: "zzz" }));
    await writeFile(join(d, "aaa.json"), JSON.stringify({ hello: "world" }));

    const listed = await store.list();
    expect(listed.records.map((r) => r.id)).toEqual(["good"]);
    expect(listed.skipped.map((s) => s.id).sort()).toEqual(["aaa", "zzz"]);
    expect(listed.skipped.every((s) => s.reason.length > 0)).toBe(true);
    expect((await store.latest()).record?.id).toBe("good");
  });

  test("overlapping saves of one uid never corrupt the file and the last submitted wins", async () => {
    const d = join(dir, "overlap");
    const store = new JsonSessionStore(d);
    for (let i = 0; i < 30; i++) {
      await Promise.all([store.save(rec("u", 1, 20000)), store.save(rec("u", 2, 10))]);
      const parsed = JSON.parse(await readFile(join(d, "u.json"), "utf8")) as SessionRecord;
      expect(parsed.updatedAt).toBe(2);
    }
  });

  test("an interrupted write leaves the previous file intact and no temp behind", async () => {
    const d = join(dir, "interrupted");
    await new JsonSessionStore(d).save(rec("s", 1000));
    const crashing = new JsonSessionStore(d, {
      writeDurable: async (path, data) => {
        await writeFile(path, data.slice(0, data.length / 2));
        throw new Error("disk vanished");
      },
    });
    await expect(crashing.save(rec("s", 2000, 50))).rejects.toThrow("disk vanished");
    const onDisk = JSON.parse(await readFile(join(d, "s.json"), "utf8")) as SessionRecord;
    expect(onDisk.updatedAt).toBe(1000);
    expect(await readdir(d)).toEqual(["s.json"]);
  });

  test("a burst coalesces: the in-flight write, then only the newest queued one", async () => {
    const d = join(dir, "coalesce");
    const g = gatedIo();
    const store = new JsonSessionStore(d, g.io);
    const a = store.save(rec("c", 1));
    await Bun.sleep(5); // A reaches the gate
    const b = store.save(rec("c", 2));
    const c = store.save(rec("c", 3));
    g.release(); // A
    await a;
    await Bun.sleep(5);
    g.release(); // C (B was superseded)
    await Promise.all([b, c]);
    expect(g.written).toEqual([1, 3]);
    const loaded = await store.load("c");
    expect(loaded.status === "ok" ? loaded.record.updatedAt : null).toBe(3);
  });

  test("a failed shared write rejects every caller that shares it", async () => {
    const g = gatedIo();
    const store = new JsonSessionStore(join(dir, "shared-fail"), g.io);
    const a = store.save(rec("f", 1));
    await Bun.sleep(5);
    const b = store.save(rec("f", 2));
    const c = store.save(rec("f", 3));
    g.release();
    await a;
    g.failNextWith(new Error("ENOSPC"));
    await Bun.sleep(5);
    g.release();
    const [rb, rc] = await Promise.allSettled([b, c]);
    expect(rb.status === "rejected" ? String(rb.reason) : rb.status).toContain("ENOSPC");
    expect(rc.status === "rejected" ? String(rc.reason) : rc.status).toContain("ENOSPC");
  });

  test("drain() resolves only after in-flight and queued writes settle", async () => {
    const g = gatedIo();
    const store = new JsonSessionStore(join(dir, "drain"), g.io);
    void store.save(rec("d", 1));
    await Bun.sleep(5);
    void store.save(rec("d", 2));
    let drained = false;
    const done = store.drain().then(() => {
      drained = true;
    });
    g.release();
    await Bun.sleep(5);
    expect(drained).toBe(false); // the queued write is now in flight
    g.release();
    await done;
    expect(g.written).toEqual([1, 2]);
  });

  test("extra record fields round-trip verbatim", async () => {
    const store = new JsonSessionStore(join(dir, "extra"));
    const extended = { ...rec("x", 10), kind: "tentacle.daemon-session", schemaVersion: 1 };
    await store.save(extended);
    const loaded = await store.load("x");
    expect(loaded.status === "ok" ? loaded.record : null).toEqual(extended);
  });

  test("an unsafe id is unreadable, never a read outside the directory", async () => {
    const d = join(dir, "unsafe", "inner");
    const store = new JsonSessionStore(d);
    await new JsonSessionStore(join(dir, "unsafe")).save(rec("outside", 1));
    for (const id of ["../outside", "", ".hidden", "a/b"]) {
      expect((await store.load(id)).status).toBe("unreadable");
    }
  });

  test("crash leftovers are swept on the first save: dead writer or too old; a live writer's temp is kept", async () => {
    // Mutation: skip the sweep in `writeAtomic` → the dead writer's temp survives.
    const d = join(dir, "temps");
    await new JsonSessionStore(d).save(rec("t", 1)); // creates the dir (and sweeps nothing)
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    const dead = join(d, `.t.json.tmp-${exited.pid}-deadbeef`);
    const liveFresh = join(d, `.t.json.tmp-${process.ppid}-cafebabe`);
    const liveStale = join(d, `.t.json.tmp-${process.ppid}-0badf00d`);
    const own = join(d, `.t.json.tmp-${process.pid}-feedface`);
    for (const path of [dead, liveFresh, liveStale, own]) {
      await writeFile(path, "{");
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(liveStale, twoHoursAgo, twoHoursAgo);

    await new JsonSessionStore(d).save(rec("t", 2)); // a fresh process's first save
    expect((await readdir(d)).sort()).toEqual(
      [
        `.t.json.tmp-${process.pid}-feedface`,
        `.t.json.tmp-${process.ppid}-cafebabe`,
        "t.json",
      ].sort(),
    );
    const listed = await new JsonSessionStore(d).list();
    expect(listed.records.map((r) => r.id)).toEqual(["t"]);
    expect(listed.skipped).toEqual([]);
  });

  test("a failed save names <uid>.json, not the hidden temp it failed on", async () => {
    const d = join(dir, "error-name");
    const store = new JsonSessionStore(d, {
      writeDurable: async (path) => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
          code: "EACCES",
        });
      },
    });
    const result = await store.save(rec("e", 1)).then(
      () => "saved",
      (error: unknown) => String(error),
    );
    expect(result).toBe(`Error: couldn't write ${join(d, "e.json")}: permission denied (EACCES)`);
    expect(result).not.toContain(".tmp-");
  });
});

describe("parseSessionRecord", () => {
  test("accepts a valid record and rejects each malformed field with a reason", () => {
    const good = rec("p", 1);
    expect(parseSessionRecord(good, "p").ok).toBe(true);
    const bad: Array<[string, unknown]> = [
      ["not an object", 42],
      ["array", []],
      ["id mismatch", { ...good, id: "q" }],
      ["no updatedAt", { ...good, updatedAt: undefined }],
      ["NaN updatedAt", { ...good, updatedAt: Number.NaN }],
      ["createdAt string", { ...good, createdAt: "1" }],
      ["no messages", { ...good, messages: undefined }],
      ["bad role", { ...good, messages: [{ role: "robot", content: "x" }] }],
      ["content not string", { ...good, messages: [{ role: "user", content: 1 }] }],
      ["extra message key", { ...good, messages: [{ role: "user", content: "x", foo: 1 }] }],
      [
        "bad tool call",
        { ...good, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "1" }] }] },
      ],
      ["title missing", { ...good, title: undefined }],
    ];
    for (const [label, value] of bad) {
      const result = parseSessionRecord(value, "p");
      expect({ label, ok: result.ok }).toEqual({ label, ok: false });
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// docs/feat/tui-spill-note.md (Q1): a spilled tool message keeps its spill on
// disk, so `--resume` shows the same note as the live row.
describe("a spilled tool message in the record", () => {
  const spill = {
    chars: 40800,
    path: ".tentacle/tool-output/fs_read-c1.txt",
    head: "h",
    tail: "t",
    omitted: 39600,
  };
  const spilled = (s: unknown): unknown[] => [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fs_read", arguments: "{}" }] },
    { role: "tool", content: "[large fs_read output: …]", toolCallId: "c1", spill: s },
  ];

  test("round-trips save → load, with and without a path", async () => {
    const store = new JsonSessionStore(join(dir, "spill"));
    const { path: _path, ...noPath } = spill;
    for (const [id, s] of [
      ["sp1", spill],
      ["sp2", noPath],
    ] as const) {
      const record = { ...rec(id, 1), messages: spilled(s) as ChatMessage[] };
      await store.save(record);
      expect(await store.load(id)).toEqual({ status: "ok", record });
    }
  });

  test("a malformed spill is refused, loudly, with the reason", () => {
    const bad: Array<[string, unknown]> = [
      ["missing head", { chars: 1, tail: "", omitted: 0 }],
      ["string chars", { ...spill, chars: "40800" }],
      ["negative omitted", { ...spill, omitted: -1 }],
      ["fractional chars", { ...spill, chars: 1.5 }],
      ["empty path", { ...spill, path: "" }],
      ["path too long", { ...spill, path: "p".repeat(4097) }],
      ["extra key", { ...spill, future: true }],
      ["not an object", "x"],
      ["array", []],
    ];
    for (const [label, s] of bad) {
      const result = parseSessionRecord({ ...rec("p", 1), messages: spilled(s) }, "p");
      expect({ label, reason: result.ok ? "ok" : result.reason }).toEqual({
        label,
        reason: "message 1 has a malformed spill",
      });
    }
  });
});

describe("JsonSessionStore.remove", () => {
  test("deletes the file; a write in flight and one queued never resurrect it", async () => {
    // Mutation: skip waiting for the running write → it renames over the deleted file.
    // Mutation: keep the queued record → the pump writes it after the rm.
    const d = join(dir, "remove");
    const gated = gatedIo();
    const store = new JsonSessionStore(d, gated.io);
    const first = store.save(rec("r", 1));
    const queued = store.save(rec("r", 2));
    while (gated.pending() === 0) await new Promise((r) => setTimeout(r, 1));
    const removing = store.remove("r");
    gated.release();
    await Promise.all([first, queued, removing]);
    await store.drain();
    expect(gated.written).toEqual([1]);
    expect(await readdir(d)).toEqual([]);
    expect((await store.load("r")).status).toBe("absent");
  });

  test("a save AFTER a remove wins: the newer record is not deleted", async () => {
    // Mutation: remove = drop queue + wait for the pump + rm → the later save(2) is deleted.
    const d = join(dir, "remove-then-save");
    const gated = gatedIo();
    const store = new JsonSessionStore(d, gated.io);
    const first = store.save(rec("r", 1));
    while (gated.pending() === 0) await new Promise((r) => setTimeout(r, 1));
    const removing = store.remove("r");
    const second = store.save(rec("r", 2));
    gated.release();
    while (gated.pending() === 0) await new Promise((r) => setTimeout(r, 1));
    gated.release();
    await Promise.all([first, removing, second]);
    await store.drain();
    const loaded = await store.load("r");
    expect(loaded.status === "ok" ? loaded.record.updatedAt : loaded.status).toBe(2);
  });

  test("an absent file is a success; an unsafe id is refused", async () => {
    const store = new JsonSessionStore(join(dir, "remove-absent"));
    await expect(store.remove("nope")).resolves.toBeUndefined();
    await expect(store.remove("../x")).rejects.toThrow(/invalid session id/);
  });
});

describe("projectKey", () => {
  test("<basename>-<12 hex>, stable, distinct for distinct paths, symlinks resolved", async () => {
    // Mutation: hash the unresolved path → the symlink gets another key.
    const { mkdir, symlink } = await import("node:fs/promises");
    const a = join(dir, "proj-a");
    await mkdir(a, { recursive: true });
    const link = join(dir, "proj-link");
    await symlink(a, link);
    expect(projectKey(a)).toMatch(/^proj-a-[0-9a-f]{12}$/);
    expect(projectKey(a)).toBe(projectKey(`${a}/`));
    expect(projectKey(link)).toBe(projectKey(a));
    expect(projectKey(join(dir, "proj-b"))).not.toBe(projectKey(a)); // absent: still keyed
    expect(projectKey("/")).toMatch(/^root-[0-9a-f]{12}$/);
  });
});
