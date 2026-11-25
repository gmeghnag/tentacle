/**
 * docs/feat/a2a.md slice S7: tasks of an ARCHIVED context are read READ-ONLY —
 * the archived record (resident, or read back by `SessionPersister.load`, which
 * writes nothing) projected through the same unit vocabulary. Never reopened,
 * never written. A small LRU + a per-caller index avoid re-reading. Real SDK
 * handler + real `SessionHost`/`Agent` + a temp store dir; each test names its
 * mutation (§9).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ListTasksRequest, type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
  type WorkUnit,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { A2AExecutor, A2ARequestHandler } from "../src/a2a/executor.ts";
import { buildAgentCard } from "../src/a2a/mapping.ts";
import { A2ATaskStore } from "../src/a2a/task-projection.ts";
import {
  ArchivedUnitIndex,
  type ArchivedUnitSource,
  type ArchivedUnitsRead,
} from "../src/external/archived-units.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

const CWD = "/tmp/a2a-archived";
const env = {} as ExecutionEnvironment;

class Scripted implements ModelProvider {
  readonly id = "scripted";
  constructor(private readonly rounds: (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield* this.rounds.shift() ?? [{ type: "text", delta: "idle" }];
    yield { type: "done" };
  }
}

const say = (delta: string): StreamEvent => ({ type: "text", delta });
const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "run", arguments: "{}" },
});
const run: Tool = {
  name: "run",
  description: "run",
  inputSchema: z.object({}).passthrough(),
  permission: "ask",
  execute: async () => ({ content: "ok" }),
};

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`until: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

function rig(rounds: (readonly StreamEvent[])[], root: string) {
  const model = new Scripted(rounds);
  const persister = new SessionPersister({
    store: new LogSessionStore(root),
    cwd: CWD,
    model: "m",
    onError: () => {},
  });
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(run),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const unreadable: string[] = [];
  const executor = new A2AExecutor({ host, version: "0.0.1" });
  const store = new A2ATaskStore({
    host,
    archived: host,
    onArchivedUnreadable: (id) => unreadable.push(id),
    isDriving: (id) => executor.isDriving(id),
  });
  const handler = new A2ARequestHandler(
    buildAgentCard({ url: "http://127.0.0.1:1/a2a", version: "0.0.1" }),
    store,
    executor,
  );
  return { host, handler, persister, unreadable };
}

const caller = (userName = "default") =>
  new ServerCallContext({ user: { isAuthenticated: true, userName } });

function request(text: string, contextId: string) {
  const message: Message = {
    messageId: crypto.randomUUID(),
    contextId,
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
  return { tenant: "", message, configuration: undefined, metadata: {} };
}

const list = (params: Partial<ListTasksRequest> = {}): ListTasksRequest => ({
  tenant: "",
  contextId: "",
  pageToken: "",
  status: TaskState.TASK_STATE_UNSPECIFIED,
  statusTimestampAfter: undefined,
  ...params,
});

const artifactText = (task: Task) =>
  task.artifacts
    .flatMap((a) => a.parts)
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");

/** Every file under `root`, name → bytes (the read-only proof); a writer's transient `.lock` aside. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(root)).sort()) {
    if (name.endsWith(".lock")) continue;
    out.set(name, await readFile(join(root, name), "utf8"));
  }
  return out;
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a2a-arch-"));
  roots.push(root);
  return root;
}

/** A task run to its end in `ctx`, then the context archived (its write landed). */
async function archivedTask(r: ReturnType<typeof rig>, ctx: string, text = "x", land = true) {
  const sent = (await r.handler.sendMessage(request(text, ctx), caller())) as Task;
  const before = await r.handler.getTask({ tenant: "", id: sent.id }, caller());
  const id = `a2a-default-${ctx}`;
  expect(r.host.close(id)).toBe(true);
  if (land) await r.persister.flush(id);
  return { sent, before, id };
}

/** A fresh host on the same store, indexing the archived session as `serve` does at start. */
async function restarted(root: string, id: string) {
  const r = rig([], root);
  const state = await r.persister.loadState(id);
  if (!state.ok) throw new Error(`loadState: ${state.reason}`);
  r.host.addArchived(state.meta);
  return r;
}

describe("a2a archived contexts — read-only projection (S7)", () => {
  // Mutation: `toRecord` drops the captured `units` (S4 drift 5) → the
  // resident reopen comes back with an empty table → red.
  test("an archive then a quick reopen (resident record) keeps the earlier units", async () => {
    const root = await tempRoot();
    const r = rig([[say("first")], [say("second")]], root);
    // Not landed: the reopen restores the archive's RESIDENT record.
    const { sent, before, id } = await archivedTask(r, "ctxQ", "x", false);
    // A NEW message on the archived context reopens it.
    const next = (await r.handler.sendMessage(request("again", "ctxQ"), caller())) as Task;
    expect(next.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(
      r.host
        .get(id)
        ?.workUnits()
        .map((u) => u.id),
    ).toEqual([sent.id, next.id]);
    expect(await r.handler.getTask({ tenant: "", id: sent.id }, caller())).toEqual(before);
    await r.persister.stop();
  });

  // Mutation: the read reopens the session (`prepareOpen` + `open`) → the
  // session is live again / the files change → red. Mutation: no archived
  // source → TaskNotFound → red.
  test("GetTask/ListTasks of an archived context: same task, never reopened, files untouched", async () => {
    const root = await tempRoot();
    const r = rig([[say("kept")]], root);
    const { sent, before, id } = await archivedTask(r, "ctxA");
    expect(r.host.get(id)).toBeUndefined();
    const files = await snapshot(root);

    // Resident (the archive's own record), then from disk on a fresh host.
    const got = await r.handler.getTask({ tenant: "", id: sent.id }, caller());
    expect(got).toEqual(before);
    await r.persister.stop();
    const r2 = await restarted(root, id);
    const disk = await r2.handler.getTask({ tenant: "", id: sent.id }, caller());
    expect(disk.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(disk)).toBe("kept");
    expect(disk).toEqual(before);
    const listed = await r2.handler.listTasks(list({ includeArtifacts: true }), caller());
    expect(listed.tasks).toEqual([before]);
    const byCtx = await r2.handler.listTasks(list({ contextId: "ctxA" }), caller());
    expect(byCtx.tasks.map((t) => t.id)).toEqual([sent.id]);

    expect(r2.host.get(id)).toBeUndefined();
    expect(r2.host.archivedCount).toBe(1);
    await r2.persister.stop();
    expect(await snapshot(root)).toEqual(files);
  });

  // A close cuts a turn waiting on an ask: the archived read closes it as the
  // reopen would (the archive's `cancelled`), at the archive's time. Mutation:
  // close it at the read's clock → the resident and the disk read differ → red.
  test("a context archived mid-turn: its task reads CANCELED, the same resident and from disk", async () => {
    const root = await tempRoot();
    const r = rig([[call("c1")]], root);
    void r.handler.sendMessage(
      { ...request("go", "ctxM"), configuration: { returnImmediately: true } as never },
      caller(),
    );
    const id = "a2a-default-ctxM";
    let taskId = "";
    await until(() => {
      taskId =
        r.host.get(id)?.workUnits()[0]?.state === "waiting"
          ? (r.host.get(id)?.workUnits()[0]?.id ?? "")
          : "";
      return taskId !== "";
    });
    expect(r.host.close(id)).toBe(true);
    const resident = await r.handler.getTask({ tenant: "", id: taskId }, caller());
    expect(resident.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    await r.persister.flush(id);
    await r.persister.stop();
    await new Promise((res) => setTimeout(res, 5)); // a later clock (not a synchronisation point)
    const r2 = await restarted(root, id);
    expect(await r2.handler.getTask({ tenant: "", id: taskId }, caller())).toEqual(resident);
    await r2.persister.stop();
  });

  // Mutation: `contextIdOf` ignores the caller on the archived side → "other"
  // reads default's archived task → red.
  test("owner scoping holds on the archived side; a deleted archived session → TaskNotFound", async () => {
    const root = await tempRoot();
    const r = rig([[say("a")]], root);
    const { sent, id } = await archivedTask(r, "ctxS");
    await expect(
      r.handler.getTask({ tenant: "", id: sent.id }, caller("other")),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect((await r.handler.listTasks(list(), caller("other"))).tasks).toEqual([]);
    expect(r.host.delete(id)).toBe(true);
    await expect(r.handler.getTask({ tenant: "", id: sent.id }, caller())).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await r.persister.stop();
  });

  // Mutation: the read drops the archived entry / blocks the id on a failure
  // (as a reopen does) → archivedCount 0 → red. Mutation: the failure is not
  // cached per version → reported twice → red.
  test("unreadable or future-version archived file → TaskNotFound + one audit; files and index untouched", async () => {
    const corruptions = [
      (log: string) => log.replace(/"schemaVersion":\d+/, `"schemaVersion":999`),
      (_log: string) => "not a log\n",
    ];
    for (const corrupt of corruptions) {
      const root = await tempRoot();
      const r = rig([[say("a")]], root);
      const { sent, id } = await archivedTask(r, "ctxU");
      await r.persister.stop();
      const r2 = await restarted(root, id);
      const file = join(root, `${id}.jsonl`);
      await writeFile(file, corrupt(await readFile(file, "utf8")));
      const files = await snapshot(root);
      for (let i = 0; i < 2; i++) {
        await expect(
          r2.handler.getTask({ tenant: "", id: sent.id }, caller()),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
      }
      expect((await r2.handler.listTasks(list(), caller())).tasks).toEqual([]);
      expect(r2.unreadable).toEqual([id]);
      expect(r2.host.archivedCount).toBe(1);
      await r2.persister.stop();
      expect(await snapshot(root)).toEqual(files);
    }
  });
});

/** A fake archived source: sessions by id, every read counted. */
function fakeSource(sessions: Map<string, { updatedAt: number; units: WorkUnit[] | "bad" }>) {
  const reads: string[] = [];
  const source: ArchivedUnitSource = {
    archivedSessions: () => [...sessions].map(([id, s]) => ({ id, updatedAt: s.updatedAt })),
    readArchivedUnits: async (id): Promise<ArchivedUnitsRead> => {
      reads.push(id);
      const s = sessions.get(id);
      if (s === undefined) return { status: "absent" };
      return s.units === "bad"
        ? { status: "unreadable", reason: "bad" }
        : { status: "ok", units: s.units };
    },
  };
  return { source, reads };
}

const turn = (id: string, result = `r-${id}`): WorkUnit => ({
  kind: "turn",
  id,
  state: "completed",
  native: "end_turn",
  endedAt: 1,
  result,
});

describe("a2a archived contexts — index + LRU (pure)", () => {
  const sessions = () =>
    new Map<string, { updatedAt: number; units: WorkUnit[] | "bad" }>(
      Array.from({ length: 10 }, (_, i) => [
        `a2a-default-c${i}`,
        { updatedAt: 1, units: [turn(`t${i}`)] },
      ]),
    );

  // Mutation: no index (scan every session on each find) → the second miss
  // reads 10 again → red. Mutation: no LRU → a hit re-reads → red.
  test("the index is built once per caller; hits come from the LRU; a miss reads nothing more", async () => {
    const { source, reads } = fakeSource(sessions());
    const index = new ArchivedUnitIndex(source, { capacity: 8 });
    expect((await index.find("a2a", "default", "t9"))?.unit.result).toBe("r-t9");
    expect(reads.length).toBe(10);
    reads.length = 0;
    expect(await index.find("a2a", "default", "nope")).toBeUndefined();
    expect((await index.find("a2a", "default", "t8"))?.contextId).toBe("c8");
    expect(reads).toEqual([]);
    // c0 and c1 were evicted (capacity 8): one read, then cached.
    expect((await index.find("a2a", "default", "t0"))?.sessionId).toBe("a2a-default-c0");
    expect((await index.find("a2a", "default", "t0"))?.unit.id).toBe("t0");
    expect(reads).toEqual(["a2a-default-c0"]);
    // Another caller's prefix reads nothing of default's sessions.
    reads.length = 0;
    expect(await index.find("a2a", "other", "t0")).toBeUndefined();
    expect(reads).toEqual([]);
  });

  // Mutation: the index ignores `updatedAt` → the changed session's new task
  // is never found → red. Mutation: a gone session stays indexed → its task
  // is still found → red.
  test("a changed session is re-read; a gone one leaves the index", async () => {
    const all = sessions();
    const { source, reads } = fakeSource(all);
    const index = new ArchivedUnitIndex(source, { capacity: 8 });
    await index.find("a2a", "default", "t0");
    reads.length = 0;
    all.set("a2a-default-c3", { updatedAt: 2, units: [turn("t3"), turn("t3b")] });
    all.delete("a2a-default-c4");
    expect((await index.find("a2a", "default", "t3b"))?.unit.result).toBe("r-t3b");
    expect(reads).toEqual(["a2a-default-c3"]);
    expect(await index.find("a2a", "default", "t4")).toBeUndefined();
    // Memory: the gone session left the index (9 sessions) and the LRU (8 → 7).
    expect(index.cachedCount()).toEqual({ indexed: 9, full: 7 });
    all.clear();
    await index.find("a2a", "default", "t0");
    expect(index.cachedCount()).toEqual({ indexed: 0, full: 0 });
  });

  // Mutation: list reads full units for an artifact-less list → reads → red.
  // Mutation: the index keeps results → `light` carries one → red.
  test("ListTasks without artifacts reads the index only; with artifacts, through the LRU", async () => {
    const { source, reads } = fakeSource(sessions());
    const index = new ArchivedUnitIndex(source, { capacity: 8 });
    const light = await index.units("a2a", "default", { results: false });
    expect(light.map((u) => u.taskId).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `t${i}`).sort(),
    );
    expect(light.every((u) => u.unit.result === undefined)).toBe(true);
    reads.length = 0;
    await index.units("a2a", "default", { results: false });
    expect(reads).toEqual([]);
    const full = await index.units("a2a", "default", { contextId: "c5", results: true });
    expect(full.map((u) => u.unit.result)).toEqual(["r-t5"]);
    expect(reads).toEqual([]); // c5 is still in the LRU
  });

  // Mutation: an unreadable read is retried and reported every time → red.
  test("an unreadable session: reported once per version, its tasks absent", async () => {
    const all = sessions();
    all.set("a2a-default-c2", { updatedAt: 1, units: "bad" });
    const { source, reads } = fakeSource(all);
    const reported: string[] = [];
    const index = new ArchivedUnitIndex(source, {
      capacity: 8,
      onUnreadable: (id, reason) => reported.push(`${id}: ${reason}`),
    });
    expect(await index.find("a2a", "default", "t2")).toBeUndefined();
    expect(await index.find("a2a", "default", "t2")).toBeUndefined();
    expect(reported).toEqual(["a2a-default-c2: bad"]);
    expect(reads.filter((id) => id === "a2a-default-c2")).toEqual(["a2a-default-c2"]);

    // Indexed fine, then unreadable at the SAME version once out of the LRU
    // (c0 was evicted): each lookup re-reads, the audit line comes once.
    all.set("a2a-default-c0", { updatedAt: 1, units: "bad" });
    reported.length = 0;
    expect(await index.find("a2a", "default", "t0")).toBeUndefined();
    expect(await index.find("a2a", "default", "t0")).toBeUndefined();
    expect(reported).toEqual(["a2a-default-c0: bad"]);
  });
});
