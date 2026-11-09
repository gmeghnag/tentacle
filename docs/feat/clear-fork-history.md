# feat/clear-fork-history — `/clear` keeps the old chat as its own session

> **Status:** implementation (awaiting the owner's answer to Q1 and approval)
> **Branch:** `feat/clear-fork-history` (this worktree, off `main` `34aab38`)
> **Type:** feat · **Size:** M (~9 source files, no protocol or TUI change) · **Blast:** load-bearing (a new write path in both session stores, AGENTS §7 "Persistence"; `TODO.md` said cross-module, §10 makes any §7 invariant load-bearing) · **Suited:** Sonnet (`claude-sonnet-5-5`), assigned by the owner 2026-11-09. **Mandatory fresh-context review** red-teaming §7 "Persistence" and "Pod … not trusted"

Vocabulary: **live session** = the session `/clear` ran in (it keeps its id, jobs and sub-agents). **Fork** = the new session holding the chat that was cleared. **Copy** = what the laptop's controller last read back from the daemon.

## Context

*— claude-opus-5-5, 2026-11-09*

**Owner requirement (QC (b) of `docs/feat/clear-keeps-jobs.md`, 2026-11-09, binding).** After `/clear`, the OLD chat is again listed in `--resume` / `/sessions` as its own session (a new id, the old messages), as it was before clear-keeps-jobs. The live session keeps its id, its jobs and its sub-agents. The laptop store writes the fork from its own copy; `serve` writes it as an archived record; `connect` only reads `session/list`.

**Today.** `/clear` runs the compaction barrier inside the session (`packages/daemon/src/hosted-session.ts:2392-2424`). With `keepSuperseded` off (the default) the laptop's next save rewrites `<uid>.jsonl` to the new segment (`packages/daemon/src/session-log-store.ts:552-566`), so the old chat is gone from disk. With it on, the old chat stays in the file, where nothing can show it (`packages/config/src/key-docs.ts:750`).

**Repro (capability gap, this tree, 2026-11-09).** Part A of the probe below, on the unchanged code, with the fork lines ignored: `live file still holds the old chat: false`. The probe writes the fork by hand with `store.write`, because `store.fork` does not exist yet. It doubles as the proof of the load-bearing assumption.

```ts
// Probe for docs/feat/clear-fork-history.md: the load-bearing assumption.
// A fork built ONLY from a copy of the messages, written as an ordinary
// session, is first-class on both stores; the laptop's last read-back before
// session/clear holds the whole old chat; no job marker travels with it.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { RemoteClient } from "@tentacle/client";
import { AgentJobs, PermissionBroker, subagentLoadNotes } from "@tentacle/core";
import type { ChatMessage, ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  Connection,
  LogSessionStore,
  SessionHost,
  SessionPersister,
  currentSegment,
  encodeSidecar,
  parseLogFile,
  segmentFromMessages,
  sidecarOf,
} from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";

const env = {} as ExecutionEnvironment;
class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "old reply" };
    yield { type: "done" };
  }
}
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const show = (ms: readonly ChatMessage[]) =>
  ms.map((m) => `${m.role}${m.note ? `[${m.note.kind}]` : ""}:${String(m.content).slice(0, 40)}`).join(" | ");
const drain = async (events: AsyncIterable<unknown>) => {
  for await (const _ of events) {
    // drain
  }
};

function forkWrite(id: string, meta: { cwd: string; model: string; createdAt: number }, messages: readonly ChatMessage[]) {
  const entries = segmentFromMessages(messages, { text: "old title", source: "model" }, `fork-${randomUUID()}`, Date.now());
  const last = entries.at(-1);
  if (!last) throw new Error("empty");
  return { id, meta, entries, messages, read: { head: { seq: last.seq, id: last.id }, outcome: "cold" } };
}

function hostRig(cwd: string, persister?: SessionPersister) {
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: cwd,
    ...(persister ? { persister } : {}),
    createAgent: () => {
      const agentJobs = new AgentJobs(2);
      runtimes.push(agentJobs);
      return {
        agent: new Agent({ model: new Quiet(), tools: new ToolRegistry(), env, agentJobs, systemPrompt: "sys" }),
        permissions: new PermissionBroker(),
        agentJobs,
      };
    },
  });
  return { host, runtimes };
}
async function dial(host: SessionHost) {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RemoteClient(c, new PermissionBroker(), undefined, { sha256 });
  await client.initialize();
  return client;
}

// ---------------------------------------------------------------- laptop
console.log("=== A. laptop store, pod-like daemon (no persister) ===");
{
  const dir = await mkdtemp(join(tmpdir(), "fork-laptop-"));
  const cwd = "/tmp/probe";
  const { host, runtimes } = hostRig(cwd);
  const client = await dial(host);
  const store = new LogSessionStore(dir);
  const uid = randomUUID();
  const s = client.newSession(undefined, uid);
  await drain(s.send("the OLD chat"));
  const gate = Promise.withResolvers<never>();
  console.log("child:", runtimes[0]?.start({ callId: "c1", agentType: "general", description: "map" }, () => gate.promise));
  await new Promise((r) => setTimeout(r, 20));

  const meta = { cwd, model: "m", createdAt: 1000 };
  const before = await s.readBack();
  if (!before) throw new Error("no read");
  await store.write({ id: uid, meta, entries: before.entries, messages: before.messages, read: before.read });
  await store.drain();
  console.log("copy before clear:", show(before.messages));
  const oldText = await readFile(store.file(uid), "utf8");
  const oldParsed = parseLogFile(oldText, uid);
  if (!oldParsed.ok) throw new Error(oldParsed.reason);
  const oldSegment = currentSegment(oldParsed);
  console.log("old segment entry types:", oldSegment.entries.map((e) => e.type).join(","));
  console.log(
    "lost/running notes a raw copy of the old segment would add:",
    subagentLoadNotes(oldSegment.entries, oldSegment.messages).map((m) => String(m.content).slice(0, 70)),
  );

  await s.clear();
  const forkId = randomUUID();
  await store.write(forkWrite(forkId, meta, before.messages) as never);
  await store.forget(forkId);
  const after = await s.readBack();
  if (!after) throw new Error("no read");
  console.log("read after clear, outcome:", after.read.outcome, "entries:", after.entries.map((e) => e.type).join(","));
  await store.write({ id: uid, meta, entries: after.entries, messages: after.messages, read: after.read });
  await store.drain();

  const listed = await store.list();
  console.log("list:", listed.records.map((r) => `${r.id === uid ? "LIVE" : "FORK"} n=${r.messageCount} title=${JSON.stringify(r.title)}`));
  console.log("files:", (await readdir(dir)).map((n) => n.replace(uid, "<live>").replace(forkId, "<fork>")).sort());
  const liveText = await readFile(store.file(uid), "utf8");
  console.log("live file still holds the old chat:", liveText.includes("the OLD chat"));
  const forkLoad = await store.load(forkId);
  if (forkLoad.status !== "ok") throw new Error(JSON.stringify(forkLoad));
  console.log("fork load:", show(forkLoad.record.messages));
  const forkText = await readFile(store.file(forkId), "utf8");
  console.log("fork entry types:", forkText.trim().split("\n").slice(1).map((l) => JSON.parse(l).type).join(","));
  const liveLoad = await store.load(uid);
  if (liveLoad.status !== "ok") throw new Error(JSON.stringify(liveLoad));
  console.log("live load:", show(liveLoad.record.messages));
  console.log("store writers resident after forget of the fork:", store.residentWriters());
  await store.write(forkWrite(forkId, meta, before.messages) as never);
  await store.drain();
  console.log("(re-written fork: same id) still one fork file:", (await readdir(dir)).filter((n) => n.startsWith(forkId)).length === 1);
  gate.reject(new Error("end"));
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- serve
console.log("=== B. serve store: archived fork, restart, reopen, continue ===");
{
  const dir = await mkdtemp(join(tmpdir(), "fork-serve-"));
  const cwd = "/tmp/probe";
  const rig = () => {
    const store = new LogSessionStore(dir);
    const persister = new SessionPersister({ store, cwd, model: "m", onError: (e: Error) => console.log("persist error:", e.message) });
    return { store, persister, ...hostRig(cwd, persister) };
  };
  const first = rig();
  const { hosted } = first.host.open(
    {
      create: true,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "the OLD chat" },
        { role: "assistant", content: "old reply" },
      ],
    },
    { send: () => {} },
  );
  await hosted.persisted();
  const copy = [...(hosted as unknown as { session: { messages: ChatMessage[] } }).session.messages];

  const forkId = randomUUID();
  const write = forkWrite(forkId, { cwd, model: "m", createdAt: 1000 }, copy);
  const record = {
    id: forkId,
    cwd,
    model: "m",
    createdAt: 1000,
    updatedAt: 2000,
    title: { text: "old title", source: "model" } as never,
    messages: copy,
    lastActiveAt: 2000,
    turns: [],
    enqueueIds: [],
    returned: [],
    archivedAt: 3000,
    logged: copy,
    logHead: write.read.head,
    paired: true,
    loadNotes: [],
  };
  const sidecar = encodeSidecar(sidecarOf(record as never));
  console.log("sidecar k/tail:", JSON.parse(sidecar).k, JSON.parse(sidecar).tail.length);
  await first.store.write({ ...write, sidecar, keepEmpty: true } as never);
  hosted.clear();
  await hosted.persisted();
  await first.persister.stop();

  const second = rig();
  const loaded = await second.persister.loadState(forkId);
  console.log("loadState ok:", loaded.ok);
  if (!loaded.ok) throw new Error(loaded.reason);
  console.log("indexed as archived:", loaded.meta.archivedAt !== undefined);
  second.host.addArchived(loaded.meta);
  console.log("session/list:", second.host.list({}).sessions.map((e) => `${e.archived ? "ARCHIVED" : "LIVE"} n=${e.id === forkId ? "fork" : "?"} title=${e.title}`));

  const client = await dial(second.host);
  const s = client.newSession(undefined, forkId, undefined, { attach: { reopen: true } });
  await s.open();
  const reopened = await s.readBack();
  console.log("reopened:", reopened ? show(reopened.messages) : null);
  await drain(s.send("continuing the fork"));
  const back = await s.readBack();
  console.log("after a new prompt:", back ? show(back.messages) : null);
  await second.persister.flush(forkId);
  await second.persister.stop();
  const finalText = await readFile(second.store.file(forkId), "utf8");
  console.log("fork log entry types after continuing:", finalText.trim().split("\n").slice(1).map((l) => JSON.parse(l).type).join(","));
  await rm(dir, { recursive: true, force: true });
}
process.exit(0);
```

```
$ bun run .tentacle/tmp/clear-fork-history/probe-fork.ts
=== A. laptop store, pod-like daemon (no persister) ===
child: { ok: true, agentId: "sa-1" }
copy before clear: system:sys | user:the OLD chat | assistant:old reply
old segment entry types: base,message,title,turn_start,message,message,title,turn_end,checkpoint,subagent_background
lost/running notes a raw copy of the old segment would add: [ "[background] sub-agent sa-1 (map) was lost: the session restarted befo" ]
read after clear, outcome: linear entries: base,message,message,title,subagent_background,checkpoint
list: [ "LIVE n=1 title=\"(empty)\"", "FORK n=2 title={\"text\":\"old title\",\"source\":\"model\"}" ]
files: [ "<fork>.jsonl", "<live>.jsonl" ]
live file still holds the old chat: false
fork load: system:sys | user:the OLD chat | assistant:old reply
fork entry types: base,message,message,message,title
live load: system:sys | user[still_running]:Background sub-agents still running (eac | user[subagent_lost]:[background] sub-agent sa-1 (map) was lo
store writers resident after forget of the fork: 1
(re-written fork: same id) still one fork file: true
=== B. serve store: archived fork, restart, reopen, continue ===
sidecar k/tail: 3 0
loadState ok: true
indexed as archived: true
session/list: [ "ARCHIVED n=? title=old title" ]
reopened: system:sys | user:the OLD chat | assistant:old reply
after a new prompt: system:sys | user:the OLD chat | assistant:old reply | user:continuing the fork | assistant:old reply
fork log entry types after continuing: base,message,message,message,title,turn_start,message,message,turn_end,checkpoint
```

(In part B the live session is not restored by the second rig, so only the fork is listed; the live reload is pinned by `packages/daemon/test/clear-reload.test.ts`.)

## Implementation

*— claude-opus-5-5, 2026-11-09*

### Load-bearing assumption

**A fork built ONLY from a copy of the messages (`segmentFromMessages` + a header, plus a sidecar on `serve`) and written as an ordinary session is first-class on both stores, and carries none of the live session's job markers. On the laptop, the read-back taken just before `session/clear` holds the whole old chat.**

Proven by the probe above (run 2026-11-09 on this tree, real `SessionHost`, `Connection`, `RemoteClient`, `LogSessionStore`, `SessionPersister`, `AgentJobs`):

- Laptop: the pre-clear read holds the whole chat, and `store.list()` shows LIVE + FORK. The fork loads with exactly the old messages. The old chat is out of the live file.
- Markers: a raw copy of the old segment WOULD add `sub-agent sa-1 … was lost` when loaded (`subagentLoadNotes`). The message-built fork has only `base,message…,title`, so it adds nothing. The live session keeps its `subagent_background`.
- `serve`: the sidecar pairs (`k` = all messages, empty overlay). After a restart `loadState` indexes it as archived, `session/list` shows it, a reopen gives the old messages, and a new prompt continues its log lineage.
- Idempotence: writing the same update twice leaves one file.
- Writer memory: after the fork, the store holds only the live session's writer.

### Preconditions (verified on this tree)

| Fact | Where |
|---|---|
| `clear()` is synchronous; it refuses at `assertIdle`, then resets the title, then runs the barrier | `daemon/src/hosted-session.ts:2392-2424` |
| The controller's `clear` is `await inner.clear(); flush()` | `cli/src/local-runtime.ts:440-444` |
| `flush` coalesces, `run` reads back, `flushed` resolves when the loop ends and never rejects | `cli/src/local-runtime.ts:314-365` |
| `bounded` + `FLUSH_ON_EXIT_TIMEOUT_MS` (3 s) | `cli/src/local-runtime.ts:196,905` |
| Frames are ordered: a read applied after a reply was issued after it | `cli/src/local-runtime.ts:332-333` |
| `ReadBack`: `messages`, `title`, `entries`, `read.head` | `client/src/remote-client.ts:207-226` |
| `session/clear` is `"once"`; a drop rejects with `DROPPED_NOT_RETRIED` (`InternalError`), a daemon refusal with its domain code | `client/src/remote-client.ts:111,1412,2393-2401`; `protocol/src/jsonrpc.ts:29` |
| A session not opened yet: `clear` is a no-op `{0,0}`, and `readBack` is null | `client/src/remote-session.ts:542-543,664-669` |
| The store's per-session queue runs ops in order; a failed write still advances the writer's segment and "the next save heals the file" | `daemon/src/session-log-store.ts:298-303,416-468` |
| Writes that are not a continuation go through `replace`; `writeWhole` is temp + fsync + rename | `daemon/src/session-log-store.ts:585,813-825` |
| A segment built from messages: `base{create}`, `message`s, a `title` for a chosen title | `daemon/src/session-log-file.ts:497-520` |
| Listing reads every `<uid>.jsonl`, newest `mtime` first; `--continue` takes `records[0]` | `daemon/src/session-log-store.ts:1152-1163`, `:1101`; `cli/src/session-resume.ts:122` |
| A persister unit reaches the store on a microtask; a synchronous `store` call made first is queued first | `daemon/src/session-persister.ts:257-290` |
| `archive()` pattern: resident record, `settleWrite`, `retryUnwritten` via `writeRecord` | `daemon/src/session-host.ts:732-739,747-764,890-910`; `session-persister.ts:225-230` |
| A `writeRecord` needs the store's writer state (else "no complete log segment") | `daemon/src/session-log-store.ts:526-528` |
| Archived entries appear in `session/list`, with `archived`; `connect` reopens them | `daemon/src/session-host.ts:388-397`; `cli/src/connect-resume.ts:106` |
| `connect` sessions have no `PersistingController` | `cli/src/connect.ts:217,239,309` (`client.newSession` directly) |
| Pods and the worker have no persister | AGENTS §7; `daemon/src/hosted-session.ts:292-300` |
| The saver's `observe` feeds the kept index's "latest session" (a fork must not go there) | `cli/src/session-saver.ts:83-85,101-107` |
| Note kinds; `still_running` | `core/src/model.ts:83` |
| Title captured before the reset (`auto`/`model`/`user`) | `daemon/src/hosted-session.ts:2401-2403`; `cli/src/local-runtime.ts:329-331` |

### Decisions (the questions in the brief)

| Question | Decision | Why |
|---|---|---|
| What "read-only" means when opened | **The plan is written for Q1 (a):** nothing writes to a fork until the user opens it. Opening it is the ordinary resume under the fork's OWN id (laptop: `--resume`, `/sessions`; `serve`: `session/open{reopen}`). It has no link to the live session. | It is what "as it was before clear-keeps-jobs" did, and costs no new mode. See **Q1**. |
| Title | The title the old chat had, with its source: `model` and `user` stay, `auto` stays derived from the first user message. No suffix. | No new format. The two rows differ by date and count. |
| Which messages | The current segment only, as the `messages` copy. With `keepSuperseded` on, older segments stay in the LIVE file, as today. | `--resume` shows the current context either way (`key-docs.ts:750`). |
| Markers | None by construction: messages + title. `still_running` note messages are also dropped from the fork (`forkableMessages`). | The work belongs to the live session. |
| Empty chats | No fork when nothing but the system prompt and notes remains. | A second `/clear` must not list an empty row. |
| Pods | The laptop forks from its own copy. Pod daemons write nothing. | §7. |
| Who forks on a laptop | Only the controller whose TUI typed `/clear`. A foreign `history{clear}` never forks. | A pod cannot make the laptop create files (§7 "gated on the laptop"), and two TUIs cannot write two forks. |
| Version skew | No wire change, no `PROTOCOL_VERSION` bump, no on-disk version change (only existing entry types). A v21 `serve` without this code simply lists no fork. | Nothing to negotiate. |
| Fork write fails | The clear still succeeds. The old chat is **never dropped before its fork is durable**: the source's later writes fail and retry the fork first. | Atomic would mean fsync inside a synchronous RPC. Durable-first loses nothing. |

### Design

**Shape.** One new store operation, `fork(sourceId, update)`, used by both stores. It runs in the SOURCE session's queue, so it precedes every later write of that source. A fork that failed stays on the source's writer state and is retried before the source's next write, which fails if the fork still does. Everything else reuses the existing paths: `segmentFromMessages`, `writeLocked`, `archivedEntry`, `settleWrite`.

**1. `packages/daemon/src/session-fork.ts` (new, pure).**

```ts
/** The chat worth keeping as a fork, without "still running" notes; null: nothing to keep. */
export function forkableMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] | null {
  const kept = messages.filter((m) => m.note?.kind !== NOTE_KIND.stillRunning);
  return kept.some((m) => m.role === "assistant" || (m.role === "user" && m.note === undefined))
    ? kept
    : null;
}

/** The ordinary, cold write of a new session holding `messages`. Mint it ONCE: a retry resends the same entries. */
export function forkWrite(input: {
  readonly id: string;
  readonly meta: LogMeta;
  readonly messages: readonly ChatMessage[];
  readonly title: TitleState;
  readonly ts: number;
}): LogWrite & { readonly read: { readonly head: LogCursor; readonly outcome: string } } {
  const chosen: SessionTitle | undefined =
    input.title.source === "auto" ? undefined : { text: input.title.text, source: input.title.source };
  const entries = segmentFromMessages(input.messages, chosen, `fork-${randomUUID()}`, input.ts);
  const last = entries.at(-1);
  if (last === undefined) throw new Error("a segment has at least its base");
  return {
    id: input.id,
    meta: input.meta,
    entries,
    messages: input.messages,
    read: { head: { seq: last.seq, id: last.id }, outcome: "cold" },
  };
}
```

**2. `packages/daemon/src/session-log-store.ts`.**

- `WriterState` (`:168`): `forks?: LogWrite[]` ("forks of this session not durable yet: retried before its next write").
- `Op` (`:183`): `| { readonly kind: "fork"; readonly update: LogWrite }`.
- Public, after `saveAside` (`:391`):
  ```ts
  /** Write a NEW session (`update.id`) holding a chat `sourceId` is about to drop, in `sourceId`'s queue: it precedes every later write of the source. On failure it stays pending, and the source's next write retries it first and fails if it still fails (the old chat is never dropped before this is durable). */
  fork(sourceId: string, update: LogWrite): Promise<void> {
    return this.enqueue(sourceId, { kind: "fork", update });
  }
  ```
- `run` (`:431`), before the `mkdir`/lock block, after the `advance` for `write`:
  ```ts
  if (op.kind === "fork") {
    const state = this.writers.get(id) ?? { segment: [] };
    (state.forks ??= []).push(op.update);
    this.writers.set(id, state);
    await mkdir(this.dir, { recursive: true });
    await this.writeForks(state);
    return;
  }
  ```
- In the lock block's `write` branch (`:449`), before `writeLocked`: `const pending = this.writers.get(id); if (pending?.forks) await this.writeForks(pending);`
- `catch` at `:464`: also rethrow `ForkWriteError` unchanged.
- New private methods:
  ```ts
  private async writeForks(state: WriterState): Promise<void> {
    while (state.forks !== undefined) {
      const next = state.forks[0];
      if (next === undefined) { state.forks = undefined; return; }
      await this.writeFork(next);
      state.forks.shift();
    }
  }

  /** Under the NEW session's own lock (§7). Its writer state goes when it lands, except `serve`'s (`sidecar`): `SessionPersister.forget` releases that one, and a sweep's `writeRecord` needs it until then. */
  private async writeFork(update: LogWrite): Promise<void> {
    const id = update.id;
    if (!isValidSessionId(id)) throw new ForkWriteError(`invalid session id ${JSON.stringify(id)}`);
    try {
      this.advance(id, update);
      const release = await this.lock(id);
      try {
        await this.writeLocked(id, update);
        if (update.sidecar !== undefined) await this.writeStateLocked(id, update.sidecar);
      } finally {
        await release();
      }
      if (update.sidecar === undefined) this.writers.delete(id);
    } catch (error) {
      throw new ForkWriteError(
        `the chat before /clear could not be kept in ${this.file(id)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  ```
- `export class ForkWriteError extends Error {}` beside `LockBusyError` (`:1167`).

Taking the fork's lock while the source's write holds the source's: no deadlock, because a fork id is fresh and its writer never takes the source's lock.

**3. `packages/daemon/src/session-persister.ts`.**

- `DaemonStore` (`:50`): `fork(sourceId: string, unit: LogWrite): Promise<void>;`
- New type, in `persisted-session.ts` beside `DaemonSessionState`:
  ```ts
  /** The chat `/clear` is about to drop, captured synchronously before the barrier. */
  export interface ClearForkCapture {
    readonly messages: readonly ChatMessage[]; // from forkableMessages
    readonly title: TitleState;                // before the clear's reset
    readonly createdAt: number;
    readonly updatedAt: number;                // the old chat's last change
  }
  ```
- New method after `archive` (`:188`):
  ```ts
  /** Write `capture` as a NEW ARCHIVED session, handed to the store NOW so it precedes the source's next unit. */
  fork(sourceId: string, capture: ClearForkCapture, archivedAt: number):
      { readonly record: DaemonSessionRecord; readonly written: Promise<boolean> } {
    const id = randomUUID();
    const write = forkWrite({ id, meta: { cwd: this.opts.cwd, model: this.opts.model, createdAt: capture.createdAt },
                              messages: capture.messages, title: capture.title, ts: archivedAt });
    const record: DaemonSessionRecord = {
      id, cwd: this.opts.cwd, model: this.opts.model, createdAt: capture.createdAt, updatedAt: capture.updatedAt,
      title: encodeTitle(capture.title, capture.messages), messages: capture.messages, lastActiveAt: archivedAt,
      turns: [], enqueueIds: [], returned: [], archivedAt,
      logged: capture.messages, logHead: write.read.head, paired: true, loadNotes: [],
    };
    if (this.stopped) return { record, written: Promise.resolve(false) };
    const saving = this.opts.store.fork(sourceId, { ...write, sidecar: encodeSidecar(sidecarOf(record)), keepEmpty: true });
    return { record, written: this.track(id, saving, true) };
  }
  ```
  `logged` and `messages` are the same array, so `sidecarOf` gives `k` = all, tail empty (probe).

**4. `packages/daemon/src/index.ts`:** `export * from "./session-fork.ts";`

**5. `packages/daemon/src/hosted-session.ts`.**

- `SessionPersistence` (`:297`): `readonly keepFork?: (sourceId: string, capture: ClearForkCapture) => void;` and a field `private readonly keepFork` set in the constructor (`:527`).
- `clear()` (`:2392`), right after `this.assertIdle();`:
  ```ts
  // BEFORE the title reset and the barrier: the old chat, as it stands.
  const messages = this.keepFork ? forkableMessages(this.session.messages) : null;
  const fork: ClearForkCapture | null = messages
    ? { messages, title: this.title, createdAt: this.createdAt, updatedAt: this.lastChangeAt }
    : null;
  ```
  `filter` returns a new array, so the in-place replacement cannot touch it.
- Before `this.lastChangeAt = this.now();` (`:2417`), so it is queued before the `persist()` at `:2419`:
  ```ts
  if (fork) {
    try {
      this.keepFork?.(this.id, fork);
    } catch (error) {
      this.reportTurnError(error); // the clear already happened: never fail it now
    }
  }
  ```

**6. `packages/daemon/src/session-host.ts`.**

- `build` (`:947`): `{ persister: this.opts.persister, keepFork: (source, capture) => this.keepFork(source, capture), ...(restored ? { restored } : {}) }`.
- New private method beside `archive` (`:721`):
  ```ts
  private keepFork(sourceId: string, capture: ClearForkCapture): void {
    const persister = this.opts.persister;
    if (!persister) return;
    const { record, written } = persister.fork(sourceId, capture, this.now());
    const entry = archivedEntry(record, record);
    this.archived.set(record.id, entry);
    void written.then((ok) => this.settleWrite(entry, ok, record));
  }
  ```
  `written` never rejects (`track`, `session-persister.ts:300-315`). A failed write stays resident, so it is listed and reopenable, and `retryUnwritten` retries it.

**7. `packages/daemon/test/support/daemon-store-spy.ts`:** `SpyDaemonStore.fork(_source, unit) { return this.write(unit); }`, matching how the spy handles `write`.

**8. `packages/cli/src/session-saver.ts`.**

- `SaveTarget` (`:20`): `Partial<Pick<LogSessionStore, "saveAside" | "fork">>`.
- New method (no `observe` listeners: a fork is not the "latest session"):
  ```ts
  /** Keep the chat `/clear` is about to drop; the outcome is reported like a save, never thrown. */
  keepFork(sourceId: string, update: LogWrite): void {
    if (!this.target.fork || this.removed.has(sourceId)) return;
    const settled = this.target.fork(sourceId, update).then(
      () => this.settle(sourceId, { ok: true }),
      (error: unknown) => this.settle(sourceId, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    this.pending.set(settled, sourceId);
    void settled.finally(() => this.pending.delete(settled));
  }
  ```
  Both branches of `.then` are handled, so no unhandled rejection is possible.

**9. `packages/cli/src/local-runtime.ts`.**

- `persistingController` signature (`:302`), a new last parameter:
  ```ts
  /** `/clear`: keep the chat it drops (docs/feat/clear-fork-history.md). Absent: `connect`, unit fakes. */
  keepFork?: (messages: readonly ChatMessage[], title: TitleState) => void,
  ```
- State (`:313`): `let lastRead: { messages: readonly ChatMessage[]; title: TitleState; head: string } | null = null; let forkedHead: string | null = null;`
- `run`, right after `lastTitle` is updated (`:331`): `lastRead = { messages: back.messages, title: lastTitle, head: back.read.head.id };`
- Before the return object:
  ```ts
  const armFork = (copy: typeof lastRead): void => {
    if (!keepFork || copy === null || copy.head === forkedHead) return;
    const kept = forkableMessages(copy.messages);
    if (kept === null) return;
    forkedHead = copy.head;
    keepFork(kept, copy.title);
  };
  ```
- `clear()` (`:440`) becomes:
  ```ts
  async clear() {
    // The copy: everything committed so far (bounded, a slow link must not hold /clear).
    flush();
    await bounded(flushed(), FLUSH_ON_EXIT_TIMEOUT_MS);
    const copy = lastRead;
    let result: Awaited<ReturnType<typeof inner.clear>>;
    try {
      result = await inner.clear();
    } catch (error) {
      if (!clearRefused(error)) {
        // The link dropped: it may have landed. A spare row beats a lost chat.
        armFork(copy);
        flush();
      }
      throw error;
    }
    armFork(copy); // queued in the store BEFORE the save below can drop the old chat
    flush();
    return result;
  }
  ```
- Beside `ended` (`:259`):
  ```ts
  /** The daemon ANSWERED with a refusal (by code): nothing changed. */
  const clearRefused = (error: unknown): boolean =>
    Object.values(DomainErrorCode).includes((error as { code?: unknown } | null)?.code as never);
  ```
- `build` (`:727-737`), a new last argument:
  ```ts
  (messages, latest) => {
    createdAt ??= Date.now();
    deps.saver.keepFork(uid, forkWrite({
      id: crypto.randomUUID(),
      meta: { cwd: deps.cwd, model: deps.model, createdAt },
      messages, title: latest, ts: Date.now(),
    }));
  },
  ```

`connect` is untouched: it has no controller, and the `serve` daemon forks. Nothing in `protocol`, `client` or `tui` changes.

### Files (dependency order)

1. `packages/daemon/src/session-fork.ts` (new); `packages/daemon/src/index.ts`.
2. `packages/daemon/src/persisted-session.ts` (`ClearForkCapture`).
3. `packages/daemon/src/session-log-store.ts`.
4. `packages/daemon/src/session-persister.ts`; `packages/daemon/test/support/daemon-store-spy.ts`.
5. `packages/daemon/src/hosted-session.ts`; `packages/daemon/src/session-host.ts`.
6. `packages/cli/src/session-saver.ts`; `packages/cli/src/local-runtime.ts`.
7. Tests below; `CHANGELOG.md`; AGENTS §7 "Persistence" (one sentence after "Superseded history …": "A `/clear` keeps the chat it drops as a NEW session (a fork, built from messages only): durable before the source's next write; `serve` writes it archived; a pod never."); this doc's Execution. `TODO.md` on merge.

### CHANGELOG (planned)

In `[Unreleased]`, in the `/clear` entry at `CHANGELOG.md:13`, replace the sentence "The old chat is no longer kept as a separate session after `/clear` (it is not in `--resume` / `/sessions`): it is no longer shown (with `sessions.keepSuperseded` on it stays on disk, like a compacted history)." with:

"The old chat stays listed in `--resume` / `/sessions` as its own session, with its own id; it has no link to the running work, which stays with the cleared session."

### Failure modes

| # | Case | Converges to |
|---|---|---|
| 1 | **Fork write fails (laptop)** (ENOSPC, EACCES) | `/clear` succeeded. The fork stays on the source's writer state. Every later write of the source retries it first and fails if it still fails, so `<uid>.jsonl` keeps the old chat until the fork is durable. One notice (`nextSaveState`), `saver.clean()` false, `saved again` on recovery. |
| 2 | **Fork write fails (`serve`)** | Same order on the source; its sidecar stays the old one (`LogWrite.sidecar`, `:80`). The fork is resident: listed, reopenable; `retryUnwritten` retries. Idempotent with the source's retry. |
| 3 | **`/clear` refused** (turn on another device, compaction, closed) | Domain code → no fork, nothing changed, the existing failure notice. |
| 4 | **Link dropped before the answer** | Unknown outcome → fork anyway, error rethrown (existing notice). If the clear did not land, the listing has a spare copy of a live chat: harmless, deletable. |
| 5 | **Retry after 4** | Same read head → `forkedHead` guard → no second fork. A new head means new content, so a new fork is right. |
| 6 | **Store retry of the same fork** | Same minted update: same id, same entries; `writeLocked` finds it (`:573-583`) and appends nothing. |
| 7 | **`/clear` twice** | The second has no conversation → no fork. |
| 8 | **Laptop crash after the clear, before the fork** | Worker: the daemon died with it, the file still holds the old chat, and `--resume` gives the old chat. Pod/relay still alive: the re-attach's cold read reaches `replace`; the old chat is set aside (`.aside`, `settleLast` `:731`), not listed, not lost. |
| 9 | **`serve` crash around the clear** | Fork queued first. Fork landed, live not: the old chat reloads live, plus a spare archived copy. Neither: unchanged. Live landed without fork: impossible (same queue). |
| 10 | **Another TUI on the shared file saves first** | It replaces `<uid>.jsonl`; the typing TUI's fork is already queued in ITS store instance, on a different file. A crash of that TUI in those milliseconds is the one loss window: recorded in Notes. |
| 11 | **Another device runs `/clear`** | That device's controller forks; here `history{clear}` only saves. A second laptop's copy follows the daemon, like a compaction. |
| 12 | **A foreign turn commits between the read and the clear** | The clear needs an idle slot; a turn in that gap ended before it, and its last messages may miss the copy. Recorded in Notes. |
| 13 | **Read-back slow or failing before the clear** | Bounded at 3 s. `lastRead` is the newest read held; no read yet → no fork, and then the file holds no newer chat either. |
| 14 | **Not opened yet** (resumed, no prompt) | `clear` is a daemon no-op, `lastRead` null: no fork, file untouched. |
| 15 | **Running children or jobs at `/clear`** | Fork has no markers (probe). Its `still_running` notes are stripped. Text inside an old compaction summary stays as written history (Notes). |
| 16 | **Pod supplies a hostile history** | Validated reads only, as every save. The id is laptop-minted (never a pod string), only an own `/clear` forks. |
| 17 | **Quit right after `/clear`** | `saver.pending` holds the fork: `drain` waits. Sealed: no read, so the file is not replaced either. |
| 18 | **Live session deleted later** | The fork is its own session and stays; a fork still pending on a deleted source is dropped with its writer state (only after a failed write). |
| 19 | **Unhandled rejection** (Bun exits) | `saver.keepFork` handles both branches; the persister's `track` never rejects; `store.fork`'s promise is consumed by those two only; `keepFork` in `clear()` is in a `try`. |
| 20 | **Version skew** | No wire or disk change. An older build reads a fork: known entries, known version. |

### Tests

Red first (the feature is absent), then green, then apply the mutation, see red, revert. Fakes: `LogStoreIo` failing/gated (`LogSessionStoreOptions.io`), `SpyDaemonStore`, the rig of `packages/daemon/test/clear-reload.test.ts`, the fake `RemoteSession` of `packages/cli/test/local-runtime.test.ts`.

| # | File · name | Property | Mutation that must turn it red |
|---|---|---|---|
| T1 | `daemon/test/session-fork.test.ts` (new) · "forkableMessages" | `null` for `[system]` and `[system, still_running]`; drops `still_running`, keeps everything else | always return the unfiltered array |
| T2 | same · "forkWrite" | `base{create}`, one `message` each, `title` only when chosen, `read.head` = last entry, no other entry type | always push a `title` |
| T3 | `daemon/test/session-log-store.test.ts` · "fork: a new listed session; source untouched; no writer left" | `list` has both, `load(fork)` equals the messages, the source's bytes are identical, `residentWriters` is unchanged | keep the writer (`writers.delete` removed) |
| T4 | same · "fork precedes the source's next write" | with `writeDurable` gated for the fork's temp, a `write` of the source does not touch the source file until the gate opens | enqueue on `update.id` instead of `sourceId` |
| T5 | same · "a failed fork blocks the source's replace, then heals" | first `writeDurable` fails: `fork` rejects, the next `write` rejects while the fork still fails and the file holds the old chat; once it succeeds, the fork exists and then the file is the new segment | drop the `writeForks` call in the `write` branch |
| T6 | same · "fork retry is idempotent" | the same update twice: one file, identical bytes | call `appendLines` instead of `writeLocked` in `writeFork` |
| T7 | same · "the fork holds its own lock" | a live `.<forkId>.lock` with `lockWaitMs: 10` → `fork` rejects with `ForkWriteError`, no file | skip `this.lock` in `writeFork` |
| T8 | same · "ForkWriteError names the fork's file" | the rejection message contains `could not be kept` and the fork's path | remove `ForkWriteError` from the `:464` rethrow |
| T9 | `daemon/test/clear-fork.test.ts` (new, real store) · "clear hands the PRE-clear chat and title" | a `model` title and the old messages reach the fork even though `clear` resets them | capture after the barrier; capture after the title reset |
| T10 | same · "the archived fork after a restart" | `loadState` ok with `archivedAt`, `session/list` shows it, a reopen gives the old messages, a prompt continues its log; the live session's id and child stay | omit `archivedAt`; skip `this.archived.set` |
| T11 | same · "no job marker in the fork" | a running child at `clear`: the fork's file has only `base,message,title`, its reload adds no note, and the live log re-emits `subagent_background` | append a `subagent_background` entry in `forkWrite` |
| T12 | same · "a failed fork keeps the old state on disk" | `writeDurable` failing for the fork: the live sidecar still names the old head, and a reload gives the old chat live | don't await `writeForks` in `write` |
| T13 | same · "a failed fork is resident, listed, and healed by a sweep" | after `reapExpired` with a healthy store: `archivedCount` holds, and the resident record is dropped | no `settleWrite` in `keepFork` |
| T14 | same · "no fork for an empty chat, nor without a persister" | a second `clear`: one fork in all; a host without persister writes nothing | remove the `forkableMessages` null check |
| T15 | same · "a throwing `keepFork` does not fail clear" | `clear` returns `{before, after}`, the error is reported | remove the `try` |
| T16 | `daemon/test/persistence.test.ts` or `clear-fork.test.ts` · "`persister.fork` is queued before the same stretch's `persist`" | spy order: `fork` then `write` | hand `store.fork` a `queueMicrotask` |
| T17 | `cli/test/session-saver.test.ts` · "keepFork" | a rejecting store: one notice, `clean()` false, `drain` lists it, no `observe` call, no unhandled rejection; a resolving store: nothing shown | call the listeners; drop the rejection handler |
| T18 | `cli/test/local-runtime.test.ts` · "clear: reads first, forks the pre-clear copy, before the save that drops it" | order: `readBack`, `inner.clear`, `keepFork(old messages, old title)`, then the next `persist` | move `armFork` after `flush()` |
| T19 | same · "a refusal forks nothing" | `TurnInProgress` → rejects, `keepFork` not called | call `armFork` in every `catch` |
| T20 | same · "a dropped link forks and rethrows" | `DROPPED_NOT_RETRIED` → rejects AND `keepFork` called once | no `armFork` in the `catch` |
| T21 | same · "the same head forks once" | a retry with the same read head: one call | remove the `forkedHead` guard |
| T22 | same · "a foreign clear forks nothing" | a `history{reason: clear}` activity saves but calls no `keepFork` | call `armFork` in `watch` |
| T23 | `cli/test/clear-fork.e2e.test.ts` (new; real `SessionHost`, `Connection`, `createLocalRuntime`, `SessionSaver`, `LogSessionStore`; `AgentJobs`, a child running) · "laptop: `/clear` leaves LIVE + FORK" | fork equals the old chat, with no lost note; the live keeps its id; also with `keepSuperseded` on | don't pass `keepFork` in `build` |

### Validation

Re-run the probe first and paste its output into Execution (T3, T10, T11 re-prove it through the real API). Narrow files while iterating (§4). Before done: `bun test` (all pass except the three opt-in skips), `bun run typecheck`, `bun run lint` (clean).

### Notes / debt (deliberate)

- **Two loss windows of a few milliseconds**: FM 10 (a typing TUI crashing while another TUI's save replaces the file) and FM 12 (a foreign turn between the read and the clear). Closing them needs the daemon to return the chat in `session/clear`, a protocol change for a very narrow race.
- **A compaction summary inside a fork** may mention work "still running" (`compact.ts:233-253`): written history, not a live claim.
- **No notice** tells the user where the old chat went: the listing is the requirement.
- **In-process fallback** (`"legacy"` step) is unchanged: close + new session already leaves the old file.
- **Suspected, unverified, out of scope:** when `setAside` rejects (`local-runtime.ts:323-327`), the read it consumed is never handed to the store, so a later linear read may extend the writer's old segment. This feature avoids the shape (the fork lives in the store's queue). To verify: fail `saveAside` once in a forked read, then read linearly.

## Owner questions

*— claude-opus-5-5, 2026-11-09* — one real decision; the plan is written for the recommended answer.

**Q1 — What "read-only" means when a fork is opened.** (a) Listed and untouched until opened; **opening it is the ordinary resume**, under the fork's own id, and a new prompt continues the fork (never the live session). Free: the probe shows it works today on both stores, and it is what `/clear` did before clear-keeps-jobs. (b) **Truly view-only**: the transcript opens and prompts are refused. It needs a new session mode in the TUI and in `session/open`, a protocol bump and its own tests: about +M. (c) Opening shows the old chat and the first prompt starts a NEW session seeded from it, leaving the fork unchanged. About +S on the laptop, plus a `serve` path, and every use adds a row. **Recommend (a)**: the fork already cannot affect the live session, so (b) and (c) only protect the fork from its own owner.

**Owner (2026-11-09): Q1 (a)** — opening a fork is the ordinary resume under the fork's own id.

## Execution

*— claude-sonnet-5-5, 2026-11-09*

**Interruptions.** The run was cut by a usage limit twice. On the first resume I inspected the partial tree: `session-fork.ts`, `index.ts` export, `ClearForkCapture`, the `session-log-store.ts` fork code (`fork`, `writeForks`, `writeFork`, `ForkWriteError`), the `session-persister.ts` `fork` (+ `DaemonStore.fork`) and the store tests T3-T8 (+ an invalid-id test) and `session-fork.test.ts` (T1, T2) were complete and consistent with the plan (tsc clean for them; 40 tests green); kept as they were, except one lint fix (`(state.forks ??= []).push` → `state.forks = [...(state.forks ?? []), …]`, `noAssignInExpressions`). The persister `fork` has one addition over the plan: a synchronous throw of `store.fork` is reported and returns `written: false`. On the second resume the tree was consistent (tsc and biome clean); I continued from the CLI tests.

**Done, in order.**
1. `daemon/src/session-fork.ts` (new) + `index.ts` export (kept).
2. `daemon/src/persisted-session.ts` `ClearForkCapture` (kept).
3. `daemon/src/session-log-store.ts` fork path (kept).
4. `daemon/src/session-persister.ts` `fork`; `daemon/test/support/daemon-store-spy.ts` `fork` (spy, added by me).
5. `daemon/src/hosted-session.ts`: `SessionPersistence.keepFork`, capture at the top of `clear()` after `assertIdle`, call (in a `try`) before `persist()`; `daemon/src/session-host.ts`: `keepFork` method + wiring in `build`. As planned.
6. `cli/src/session-saver.ts` `keepFork` (also catches a synchronous throw of the store call); `cli/src/local-runtime.ts`: `lastRead`/`forkedHead`, `armFork`, `clearRefused`, new `clear()`, `build` passes `keepFork`.
7. Tests (below); `CHANGELOG.md` (the `/clear` entry sentence replaced as planned); AGENTS §7 one sentence; this doc: Q1 owner answer, `Suited:` line.

**Drifts.**
- `local-runtime.ts`: `lastRead.head` is `back.read?.head?.id ?? ""`, not `back.read.head.id`: many existing unit fakes of `readBack` return only `{ messages }`, and the strict form threw in `run` (18 existing tests failed). With `""` the `forkedHead` guard still works.
- `armFork` wraps `keepFork(...)` in a `try` that goes to `onFlushError` (plan: none). Defensive; `saver.keepFork` does not throw.
- The existing test `T16 (clear-keeps-jobs)` in `cli/test/local-runtime.test.ts` encoded the old contract (one read after `clear`); `/clear` now reads first by design, so it now expects the pre-clear read, then the post-clear read (`saved == [["old"],["note"]]`). Changed on purpose.
- Plan T17-T22 and T23 live in new files (`cli/test/session-saver-fork.test.ts`, `cli/test/clear-fork-controller.test.ts`, `cli/test/clear-fork.e2e.test.ts`) instead of the existing `session-saver.test.ts` / `local-runtime.test.ts` (a new file was simpler to write with the tools available). T9-T16 are all in `daemon/test/clear-fork.test.ts` (not split into `persistence.test.ts`).
- T10: the reopen goes through `host.prepareOpen` + `host.open({reopen: true})` and asserts the old messages; it does NOT send a new prompt on the fork (the probe, part B, showed that continuing works; the test does not pin it).
- T23 with `keepSuperseded` on: `load()` of the live file returns only the current segment, so the test asserts the old chat is in the live FILE (bytes) iff `keepSuperseded`, and never in the loaded messages.

**Probe (re-run).** I did NOT re-run the plan's probe script as such (it was run by the architect on this tree). The same properties are re-proved through the real API by T3 (store list + untouched source + no resident writer), T10 (archived after a restart, reopen), T11 (fork file is only `base,message,message,message`, no note on reload, live log keeps `subagent_background`) and T23 (laptop: LIVE + FORK).

**Red/green.** HONEST: the feature code existed before the tests of this run (written by the cut run and by me before the tests), so I did NOT see each test red on the unimplemented code first. Non-vacuity was shown by mutation instead (cp backup, mutate, run, restore, `shasum` equal to the pre-mutation hash for all five source files):

| Mutation | Red (failing line, abridged) |
|---|---|
| `forkableMessages`: `kept = messages` | `forkableMessages > T1 …` fail |
| store `writeFork`: drop `writers.delete` | `fork … > T3 a new listed session …` fail |
| `fork` enqueues on `update.id` | T4, T5, "an invalid fork id…" fail |
| drop `writeForks` in the `write` branch | `T5 a failed fork blocks the source's replace…` fail |
| `hosted-session`: drop the `keepFork` call | `clear-fork.test.ts`: T9-T16 all fail (0 pass / 8 fail) |
| `forkableMessages`: `? kept : kept` (no null) | `T14` and `T1` fail |
| `local-runtime`: drop the `forkedHead` guard | `T21 the same read head forks once` fail |
| `clear`: arm the fork on every error | `T19 a daemon refusal forks nothing` fail |
| `clear`: never arm in the `catch` | `T20 a dropped link forks anyway` fail |
| `build`: no `keepFork` to the saver | `clear-fork.e2e` fails |

NOT mutation-tested / weak: **T2** (a mutation `title.source === "auto"` → `false` was NOT run: the mutate script could not be run without approval, so it was not done); **T6, T7, T8** (not mutated); **T17** (saver tests, not mutated); **T18's ordering** — moving `armFork` after `flush()` stays green: an EQUIVALENT mutant, because `flush()` starts the read synchronously and the store write only follows an `await`, so the call order into the store is the same. The ordering that matters (fork before the source's later write) is pinned in the store by T4/T5, and on `serve` by T16 (whose mutation, removing the fork call, is red, but not a reorder mutation). **T22** ("a foreign clear forks nothing") passes trivially on today's code (`watch` never calls `armFork`); no mutation done.

**Gate.** `bunx tsc --noEmit` clean; `bunx tsc -p apps/mobile` clean; `bunx biome check .` clean (807 files, no fixes); `bun test packages`: **6157 pass, 3 skip (the opt-in ones), 0 fail**. The exec confinement F2 flake did not occur. The first full run, before the `read?.head` fix and the T16 update, had 18 failures (above), all fixed.

**Suspected `setAside` bug (Notes).** Not verified and not fixed (out of scope; no probe run for lack of budget). To verify: fail `saveAside` once in a forked read, then read linearly.

**Not done / not verified.** (1) No fresh-context Review (mandatory for this load-bearing task: still to do). (2) The mutation gaps listed above. (3) T10 does not pin "a new prompt continues the fork". (4) `TODO.md` untouched, per instructions. (5) No manual TUI run.

## Review

*— claude-opus-5-5, 2026-11-09* (fresh context; a different model from the executor, Sonnet, but the same model as the plan's author: blind spots shared with the plan can survive this pass.)

**Verdict: REQUEST-CHANGES.** The happy path holds on both stores. One failure path corrupts a fork on `serve`, and a slow read silently loses the last turn on the laptop. Both fixes are small and neither needs an owner decision.

### Findings

**H1. A pending fork is retried blindly, and rewrites a fork that has already landed and moved on (`serve`).** `packages/daemon/src/session-log-store.ts:502-540` (`writeForks`, `writeFork`).

Failure scenario, reproduced on the real `SessionHost` + `LogSessionStore` + `RemoteClient` (`.tentacle/tmp/clear-fork-history/review-retry-regress.ts`):
1. `/clear`, and the fork write fails (ENOSPC). It stays on the source's `state.forks`, and it stays resident and listed.
2. The disk recovers and a sweep heals the fork through `writeRecord`. `state.forks` still holds it.
3. The user reopens the fork and continues it (the ordinary resume of Q1 (a)).
4. The live session's next write runs `writeForks`, which re-applies the original cold update: `advance` resets the fork's writer, `writeLocked` replaces the file, and `writeStateLocked` rewinds the sidecar.

```
after continuing:          base,message,message,message,title,turn_start,message,message,turn_end,checkpoint  archivedAt: undefined  head seq 14
after source's next write: base,message,message,message  archivedAt: <stamped again>  head seq 4
files: … <fork>.stale-….aside      (holds the continued turn, unlisted)
after next fork prompt:    base,message,message,message,turn_start,message,message,turn_end,checkpoint  log has the continued text: false
reload:                    "k" (7) is past the log's history (5)
```

The running session's history leaves the log, it is stamped archived while live, and after the next prompt the session can no longer be reloaded after a restart. Skipping the pending fork only when a queue says so would not be enough: the fork's own queue and the source's queue are different, so the retry also races the sweep's `writeRecord`. The trigger needs a failed write first, so it is rare; the outcome breaks the §7 persistence contract (a sidecar paired with the wrong log).

Fix: in `writeForks`, before each write, drop a fork that has already landed: if `<fork>.jsonl` exists and (`update.sidecar === undefined` or `<fork>.state.json` exists), `shift()` and continue, without `advance`, `writeLocked` or `writeStateLocked`. A log without its sidecar (the sidecar write failed) still goes through the retry. The check belongs under the fork's lock, in a `writeFork` early return. Regression test in `packages/daemon/test/clear-fork.test.ts`: the four steps above, asserting the fork's log, sidecar and a reload after the source's next write. This also pins "a new prompt continues the fork".

**M1. A pre-clear read slower than the bound silently forks a stale copy, and the newest turn is lost.** `packages/cli/src/local-runtime.ts:474-475`.

`const copy = lastRead` is taken when the 3 s bound expires, not when the clear is answered. Reproduced with a fake session (`.tentacle/tmp/clear-fork-history/review-stale-copy.ts`), read taking 3.2 s, clear answered after it:

```
3203ms read answered: 5 messages
3203ms persist 5 messages
3402ms clear answered
3403ms keepFork 3 messages        fork holds latest turn: false
```

The late read did arrive before the clear's reply, and the file held all 5 messages; the post-clear save then replaces them, and the fork holds 3. There is no notice. FM 13 ("`lastRead` is the newest read held") does not cover this: the newer read was held by the time the fork was armed.

Fix: take the copy after `inner.clear()` settles (success and `catch`), from reads STARTED before the clear was sent. A `let clearSent = false`, set just before `inner.clear()` and reset in a `finally`; in `run`, `const pre = !clearSent` before `await inner.readBack()` and assign `lastRead` only when `pre`. The channel is ordered (`local-runtime.ts:347-348`), so every such reply precedes the clear's. Test: the repro above in `clear-fork-controller.test.ts`, asserting the fork holds the latest turn, and that a read started after the clear is never the copy.

**M2. The fork's "sidecar after the log" order is not pinned.** `packages/daemon/src/session-log-store.ts:528-529`; the gap is in `packages/daemon/test/session-log-store.test.ts`.

Mutation: `writeStateLocked` before `writeLocked` → 46 pass, 0 fail across both fork test files. The code is right today, but a §7 ordering rule (focus point 2) has no guard, and a swap would let a crash leave a sidecar naming a log entry that does not exist.

Fix: a store test with an `io` whose `writeDurable` rejects for paths containing `<forkId>.jsonl`: `fork` rejects with `ForkWriteError`, and `<forkId>.state.json` does not exist. Red under the mutation above.

### Exec's declared drifts

| Drift | Judgment |
|---|---|
| `back.read?.head?.id ?? ""` | Harmless. `read` is required on a real `ReadBack`; `""` only comes from unit fakes. The fork's content comes from `messages`, so it cannot make a fork wrong or empty; the worst case is the guard suppressing a second fork on a fake. |
| Rewritten clear-keeps-jobs T16 | Correct. The pre-clear read is the design, and the new `[["old"],["note"]]` states it. |
| `armFork` catches a throwing `keepFork` | Fine. Reported through `onFlushError`; the clear has already happened. |
| T10 does not pin continuation | Not a finding by itself. Continuation works on this branch (first line of the H1 trace), and the H1 regression test will pin it. |
| No red-before-green (§4, §9) | A real deviation from a mandatory rule, disclosed honestly. The ten mutations are stronger evidence than a red caused by a missing feature; two further mutations were run here. |

### Attacks tried

| Attack | Result |
|---|---|
| Live session's lineage, lock, uid after a healthy or failed fork | Holds. The fork runs under its own lock in the source's queue; a failed fork fails the source's write and keeps the old chat (T5, T12). |
| Fresh writer `{segment: []}` from the fork op on a source with no writer | Holds. `advance` and `writeLocked` treat it exactly like an absent writer (`:571`, `:598`). |
| Markers in the fork | Holds. Messages only; `still_running` stripped (T11). |
| Pod daemon, in-process worker | Hold. `keepFork` is wired only with a persister (`session-host.ts`), T14; the laptop forks from its validated reads. |
| Foreign `/clear`, two TUIs on one `serve` session | Hold. One synchronous daemon-side fork; `watch` never arms. |
| Second `/clear` before the first fork lands | Holds. The new read has nothing to keep; if the read fails, the same head is guarded. |
| `history{clear}` read racing `armFork` | Holds by frame order. That read is issued after the clear's reply is on the wire. Argued from the code, not run. |
| Crash between the fork's log and sidecar | Holds. The index comes from `.state.json` (`session-log-store.ts:1135`), so the log is an invisible orphan; the source had not moved. A leftover file, nothing lost. |
| Quit right after `/clear` | Holds. `saver.pending` holds the fork; sealed, no save replaces the file. |
| `connect --continue` picking the fork | Holds. `session/list` sorts on `lastChangeAt`; the fork carries the old chat's value, older than the live session's. Reopen is `entry.archived` (`connect-resume.ts:106`). |
| `session/delete` of a failed fork, then the retry | The file can return until the next start, when the tombstone removes it. Covered by the H1 fix when the file exists; otherwise harmless. |

Premises checked against the code: the store's `advance` / `writeLocked` (`:570-658`), `settleWrite` and `retryUnwritten`, `track`, `flush` / `flushed`, the `DomainErrorCode` split (`InternalError` is not a domain code, so a dropped link arms the fork). The rest of the premise table was not re-verified, and the Context's Repro was not re-run on `main` (the owner's token budget).

### Mutations (this review)

| Mutation | Result |
|---|---|
| `writeFork`: no lock | T7 fails: non-vacuous |
| `writeFork`: sidecar before log | Survives: M2 |

The backup step was denied, so `session-log-store.ts` was restored by reversing the edits instead of the planned `shasum` comparison. `git status` is clean afterwards, so the file matches `HEAD`.

### Owner questions

None.

### Gate

`bun run check`: typecheck clean, Biome clean (807 files), **6199 pass, 3 skip (the opt-in ones), 0 fail**, on the tree as committed, before this section was added.

**How the executor behaved.** Plan followed, drifts and mutation gaps disclosed accurately, nothing overstated. The gaps it declared are real and it named them itself; H1 and M1 are plan-level misses (FM 2 and FM 13) that it implemented as specified.

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-09*

Exactly the Review's three findings; nothing else changed. Files touched: `packages/daemon/src/session-log-store.ts`, `packages/cli/src/local-runtime.ts` (fixes) and their three test files. `TODO.md` untouched, no commit.

### H1 — a landed fork is not retried (`serve`)

**As built.** `writeFork` (`packages/daemon/src/session-log-store.ts:535`) now takes the fork's lock FIRST, then early-returns when the fork already landed: new `landed(update)` (`:563`) = `<fork>.jsonl` exists **and** (`update.sidecar === undefined` **or** `<fork>.state.json` exists); `exists` is the new helper at `:237`. On that path there is no `advance`, no `writeLocked`, no `writeStateLocked` — so neither the log nor the sidecar is touched. A log with no sidecar where one is expected (the sidecar write failed) still goes through the retry, as the Review specifies. `advance` moved inside the `try` (after the skip), which is the only change of relative order: the fork no longer folds its segment before the lock; `writeLocked` reads `this.writers` under the lock either way (`:624`), so a skipped fork leaves the source's writer state alone — and for `sidecar === undefined` it still deletes it, exactly as the landed path did before.

**Regression test.** `packages/daemon/test/clear-fork.test.ts:287` — the Review's four steps on the real `SessionHost` + `LogSessionStore`: (1) `/clear` with the fork write failing (ENOSPC) → listed; (2) disk healthy, `reapExpired` heals it; (3) the fork is reopened (`prepareOpen` + `open{reopen}`) and CONTINUED with a prompt until `!running`; (4) the live session runs a turn. Asserts the fork's log and sidecar are byte-identical across (4), no `.aside` appears, and a reload keeps `"continuing the fork"`.

**Red (current code).** the same trace as the Review, now as an assertion:

```
(fail) serve: /clear keeps the old chat as an archived fork > H1 a fork that already landed is not retried …
  expect(await readFile(forkLog, "utf8")).toBe(continued);
  - {"type":"base","critical":true,"inc":"a9feb067…","reason":"reload","count":3,"seq":5 …}
  - … turn_start/message("continuing the fork")/turn_end/checkpoint (seq 14)
  + {"type":"base","critical":true,"inc":"fork-64962c69…","reason":"create","count":3,"seq":1 …}
  + the four cold entries only
  0 pass, 1 fail
```

**Green.** `bun test packages/daemon/test/clear-fork.test.ts` → `9 pass, 0 fail`.

**Mutation (fix reverted).** Deleting the `if (await this.landed(update)) { … return; }` block → `H1 … [87.78ms] (fail)`, `0 pass, 1 fail`. Restored: `1 pass, 0 fail`. The review's own repro was re-run against the fixed tree (`.tentacle/tmp/clear-fork-history/review-retry-regress.ts`): `after source's next write: base,message,message,message,title,turn_start,message,message,turn_end,checkpoint` (unchanged), `files: [<live>.state.json, <live>.jsonl, <fork>.jsonl, <fork>.state.json]` (no aside), `log has continued text: true`, `reload messages: [system:sys, user:the OLD chat, assistant:old reply, user:continuing the fork, …]` — previously `"k" (7) is past the log's history (5)`.

### M1 — the copy is taken after `/clear` settles

**As built.** `packages/cli/src/local-runtime.ts:483` (`clear`): the copy is no longer a `const copy = lastRead` taken at the bound. A `let clearSent = false` (`:332`) is set just before `inner.clear()` (`:492`) and reset in the `finally`; in `run`, `const pre = !clearSent` (`:338`) is read BEFORE `await inner.readBack()` and gates the `lastRead` assignment (`:354`). So only a read STARTED before the clear was sent can become the copy (the channel is ordered, so its reply precedes the clear's), and a pre-clear read that resolves after the 3 s bound still lands. `armFork(lastRead)` (`:507`) and the catch's `const copy = lastRead` both read after the clear settled.

**Regression test.** `packages/cli/test/clear-fork-controller.test.ts:117` — the review's repro: read #1 fast (the held copy is the OLD chat), then read #2 in flight when `clear()` is sent, taking 3.2 s (`> FLUSH_ON_EXIT_TIMEOUT_MS`), with the clear's reply after it and a distinguishable post-clear history behind it. Asserts one fork holding ALL messages of the newest pre-clear chat.

**Red (current code).**

```
(fail) M1 a pre-clear read slower than the 3 s bound forks the NEWEST chat, not the stale copy [3203.23ms]
  expect(forks[0]?.messages).toEqual(NEWEST)
  - {"content":"the newest turn","role":"user"}   - {"content":"newest reply","role":"assistant"}
  0 pass, 1 fail
```

**Green.** `bun test packages/cli/test/clear-fork-controller.test.ts` → `7 pass, 0 fail`.

**Mutation (fix reverted):** the copy taken at the bound again (`const copy = lastRead` before the clear, `armFork(copy)`, no catch copy) while `clearSent`/`pre` stayed → `M1 … [3203.18ms] (fail)`, `0 pass, 1 fail`; restored → `7 pass, 0 fail`.

### M2 — the sidecar-after-log order is pinned

**Test only, no code change.** `packages/daemon/test/session-log-store.test.ts:894`: an `io` whose `writeDurable` rejects for paths containing `f1.jsonl`; `store.fork` with a `sidecar` rejects with `ForkWriteError`, and `f1.state.json` does not exist in the directory.

**Red.** Green on today's code (the code is right), so non-vacuity was shown by the Review's mutation — `writeStateLocked` before `writeLocked` in `writeFork`:

```
(fail) fork (…): … > M2 the fork's sidecar is written AFTER its log: a failed log write leaves no state file [1.96ms]
  expect(await readdir(where)).not.toContain("f1.state.json")
  Expected to not contain: "f1.state.json"  /  Received: [ "s.jsonl", "f1.state.json" ]
  1 pass, 1 fail
```

Restored (`git diff --stat` unchanged from the five intended files) → `2 pass, 0 fail`.

### Gate

`bun run typecheck` clean (`tsc --noEmit` + `tsc -p apps/mobile`); `bun run lint` clean (Biome, 807 files, no fixes); `bun test` → **6202 pass, 3 skip (the opt-in ones), 0 fail**, 6205 tests / 433 files. `git status` shows only the five intended files (two sources, three test files); scratch runs stayed in `.tentacle/tmp/clear-fork-history/`.

### Drift

- None from the Review's fixes. One implementation detail worth naming: `advance` moved after the lock/skip inside `writeFork`, so a skipped fork does not touch the source's writer state (it only deletes its own when it has no sidecar). The `landed` check is under the fork's lock, as the Review asked.
- M2 needed no code change, as the Review said (the ordering was already right). Its test is red only under the mutation, shown above.

## Review — round 2

*— claude-opus-5-5, 2026-11-09* (the same reviewer and context as round 1, on the fix commit `6f8cc09` by DeepSeek.)

**Verdict: REQUEST-CHANGES (tests only).** The three production fixes are correct and the round 1 repros now pass. Two guards the fixes rely on have no test: both survive a mutation, and each one, if broken, is a silent loss of the old chat. No production code needs to change.

### Round 1 findings

| Finding | Status | Evidence |
|---|---|---|
| H1 | Fixed as specified | `review-retry-regress.ts` now keeps the fork's log and sidecar, the second prompt continues it, there is no `.aside`, and the reload gives the continued chat. Red shown in Execution. |
| M1 | Code fixed; test incomplete (R2-M1) | `review-stale-copy.ts`: `keepFork 5 messages`, `fork holds latest turn: true`. Red shown in Execution for the stale copy. |
| M2 | Fixed | Mutation (sidecar before log): the `M2` test fails. |

### Findings

**R2-M1. "A read started after the clear is never the copy" is not pinned.** `packages/cli/test/clear-fork-controller.test.ts:149-150`, guarding `packages/cli/src/local-runtime.ts:338`.

Round 1 asked for this assertion. Mutation `const pre = true`: all tests pass. The test's own comment says the `AFTER` history makes such a read detectable, but `held` only becomes `AFTER` once `answered` has resolved, so the read started after `clearSent` still returns `NEWEST`. Failure scenario if the guard regresses: a post-clear read becomes `lastRead`, `forkableMessages` returns null, no fork is written, and the save that follows drops the old chat with no notice.

Fix: swap the two lines of the fake's `clear`, so `held = readOf(AFTER, "h-cleared")` comes before `await answered.promise` (the daemon reset the history; its reply is still on the way). The `again` read then returns `AFTER` before the clear settles, and `expect(forks[0]?.messages).toEqual(NEWEST)` goes red under the mutation.

**R2-M2. "A log without its sidecar still goes through" is not pinned.** `packages/daemon/src/session-log-store.ts:567`; the gap is in `packages/daemon/test/session-log-store.test.ts`.

Mutation: `landed` returns `true` as soon as the log exists: all tests pass. This is the case where the skip would hide a fork that really needs its write. If the guard regresses: the log lands, the sidecar write fails, the retry is skipped, and the source's next write drops the old chat, while `serve` indexes from `.state.json` (`session-log-store.ts`, the listing filter), so the fork is never listed after a restart.

Fix: a store test with an `io` whose `writeDurable` rejects while a flag is set for paths containing `f1.state.json`. With a sidecar on the update: `fork` rejects with `ForkWriteError` and `f1.jsonl` exists; clear the flag; the source's next `write` resolves and `f1.state.json` exists.

### Attacks on the fixes

| Attack | Result |
|---|---|
| `landed` hiding a fork that needs a rewrite | Holds in the code. The log is written by temp + rename, so an existing log is complete, and a failing `stat` counts as absent, so the write is attempted and fails loudly. The sidecar branch is correct but unpinned (R2-M2). |
| `landed` racing the sweep's `writeRecord` | Holds. The check and `advance` both run under the fork's lock. |
| `clearSent` leaking on an error path | Holds. It is set immediately before the `try` and reset in `finally`. The `flush()` in the `catch` starts its read while the flag is still set, so that one read is not a copy candidate; the next pre-clear flush replaces it. |
| Lock order and deadlock | Holds, argued from the code. The only nested order is source then fork (the `write` branch); the `fork` op takes only the fork's lock. A fork of a reopened fork nests onto a newly minted id, so no cycle can form, and every wait is bounded by `lockWaitMs`. |
| First fork attempt failing at the lock (`advance` now runs after it) | Below MEDIUM, a small regression from round 1. `review-lock-fail.ts`: the sweep's unit fails with `no complete log segment to save yet`, and the source's next write lands the fork. It stays unhealed only if the source is deleted before writing again; a restart then loses the resident row. |
| A paged pre-clear read that spans the clear | Below MEDIUM, argued from the code. `run` has not assigned `lastRead` by the time the clear is answered, so the fork holds the previous read, as before the fix. It needs a read slower than 3 s and a delta larger than one page. |

### Mutations (round 2)

| Mutation | Result |
|---|---|
| `writeFork`: sidecar before log | `M2` fails: non-vacuous |
| `landed` ignores the sidecar | Survives: R2-M2 |
| `const pre = true` | Survives: R2-M1 |

The three were applied together; the one failing test is named for its own mutation. All were reverted by inverse edits, and `git status` was clean before this section was written.

### Gate

`bun run check` on the fix commit: typecheck and Biome passed (the script stops before the tests otherwise), **6202 pass, 3 skip (the opt-in ones), 0 fail**, 6205 tests across 433 files.

## Execution — fix round 2

*— deepseek (tentacle --profile deepseek), 2026-11-09*

The Review's two findings, test-only: no file under `packages/*/src/` changed (`git diff --stat packages/*/src` empty at the end of every step below). Files touched: `packages/cli/test/clear-fork-controller.test.ts`, `packages/daemon/test/session-log-store.test.ts`, plus this section. `TODO.md` untouched, no commit.

### R2-M1 — a read started after the clear is never the copy

**As built.** `packages/cli/test/clear-fork-controller.test.ts:151` — the review's own edit to the fake's `clear`: `held = readOf(AFTER, "h-cleared")` now runs BEFORE `await answered.promise` (the daemon reset the history at once; its reply is still on the way). A save started after `clearSent` is set therefore reads `AFTER` inside the clear's own wait, and if that read became the copy, `armFork` would fork `AFTER` — or, since `AFTER` is a different head, the assertion on `NEWEST` fails outright.

**Green on today's code.** `bun test packages/cli/test/clear-fork-controller.test.ts` → `7 pass, 0 fail` (3.31 s).

**Mutation — `const pre = true` at `packages/cli/src/local-runtime.ts:338`:**

```
(fail) clear keeps the old chat (persistingController) > M1 a pre-clear read slower than the 3 s bound forks the NEWEST chat, not the stale copy [3205.11ms]
  expect(forks[0]?.messages).toEqual(NEWEST)
  - {"content":"the OLD chat","role":"user"} … - {"content":"newest reply","role":"assistant"}
  + {"content":"answered after the clear","role":"assistant"}
  6 pass, 1 fail
```

The forked chat is the post-clear `AFTER` history: the regression is caught, and the failure names it. Restored (`const pre = !clearSent;`, `git diff --stat packages/cli/src` empty) → `7 pass, 0 fail`.

### R2-M2 — a log without its sidecar still goes through

**Test only, no code change** (`packages/daemon/test/session-log-store.test.ts:894`, `R2-M2`). An `io` whose `writeDurable` rejects (`ENOSPC`) while `failSidecar` is set for paths containing `f1.state.json` (`writeWhole` writes the temp `.f1.state.json.tmp-…`, so a rename can never sneak the sidecar past the fault). With a sidecar on the fork update: `store.fork("s", …)` rejects with `ForkWriteError`, `f1.jsonl` EXISTS and `f1.state.json` does not — the state round 1's H1 retry exists for. Then the fault is cleared and the SOURCE's next `write` (the clear's cold base) resolves, and `f1.state.json` exists holding the update's bytes, with `f1` still loading as the old chat.

**Green on today's code.** `bun test packages/daemon/test/session-log-store.test.ts` → `40 pass, 0 fail`.

**Mutation — `landed` returns `true` as soon as the log exists (`packages/daemon/src/session-log-store.ts:567` → `return true;`):**

```
(fail) fork (docs/feat/clear-fork-history.md): a NEW session holding the chat a source is about to drop > R2-M2 a log whose sidecar failed still goes through: the source's next write heals the fork [4.03ms]
  expect(await readdir(where)).toContain("f1.state.json")
  Expected to contain: "f1.state.json"
  Received: [ "s.stale-1794253277191-ce2326f1.aside", "s.jsonl", "f1.jsonl" ]
  39 pass, 1 fail
```

The log is there, the sidecar never is — `serve` would never list the fork after a restart. Restored → `40 pass, 0 fail`, and `git diff --stat packages/*/src` empty.

### Gate

`bun run check` on this tree: `tsc --noEmit` + `tsc -p apps/mobile` clean, Biome clean (807 files, no fixes), **6203 pass, 3 skip (the opt-in ones), 0 fail**, 6206 tests / 433 files (6202 + the one new `R2-M2` test; the round 1 `M1` test was only edited).

### Drift

- None from the Review. Both findings were test-only, as it said: no production code needed a change, and each test is red only under its own mutation, named above.
