/**
 * Session titles on the laptop (docs/feat/session-titles.md): the laptop store
 * persists the DAEMON's title — never derives one over a stored one — a rename
 * goes through the runtime, a resumed session seeds its chosen title, and the
 * `--resume` list shows it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore, type SessionRecord, recordFromSnapshot } from "@tentacle/agent";
import type { RemoteSession, SessionTitleNotice } from "@tentacle/client";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime, persistingController } from "../src/local-runtime.ts";
import { inProcessSessions } from "../src/session-jobs.ts";
import { resolveResume } from "../src/session-resume.ts";
import { SessionSaver } from "../src/session-saver.ts";

const env = {} as ExecutionEnvironment;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}
const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/** Replies `texts[i]` to call i; counts calls. */
class Replies implements ModelProvider {
  readonly id = "replies";
  calls = 0;
  constructor(private readonly texts: readonly string[]) {}
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    const text = this.texts[this.calls++] ?? "more";
    await tick(1);
    yield { type: "text", delta: text };
    yield { type: "done" };
  }
}

function daemon(turns: ModelProvider, titles?: ModelProvider) {
  const host = new SessionHost({
    defaultCwd: "/tmp/work",
    createAgent: () => ({
      agent: new Agent({ model: turns, tools: new ToolRegistry(), env }),
      permissions: new PermissionBroker(),
      ...(titles ? { titleModel: titles } : {}),
    }),
  } as ConstructorParameters<typeof SessionHost>[0]);
  const [d, c] = createChannelPair();
  const connection = new Connection(d, host);
  return { host, channel: c, dispose: () => connection.close() };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-titles-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runtimeOn(
  name: string,
  d: ReturnType<typeof daemon>,
  resume: SessionRecord | null = null,
) {
  const store = new JsonSessionStore(join(dir, name));
  const saver = new SessionSaver(store, () => {});
  const runtime = await createLocalRuntime({
    channel: d.channel,
    disposeTransport: d.dispose,
    permissions: new PermissionBroker(),
    saver,
    cwd: "/tmp/work",
    model: "m",
    resume,
  });
  return { store, saver, runtime };
}

const renameOf = (ctl: object) => (ctl as { rename?: (title: string) => Promise<string> }).rename;

describe("laptop store titles", () => {
  test("L1 a title generated while idle reaches the laptop store (a save carrying it)", async () => {
    const d = daemon(new Replies(["hi back"]), new Replies(["Greeting exchange"]));
    const { store, saver, runtime } = await runtimeOn("idle", d);
    const ctl = runtime.createSession();
    await drain(ctl.send("hello"));
    await until(() => d.host.list({}).sessions[0]?.title === "Greeting exchange", 500).catch(
      () => {},
    );
    await tick(20);
    await saver.drain();
    const [record] = (await store.list()).records;
    expect(record?.title).toEqual({ text: "Greeting exchange", source: "model" });
    await runtime.dispose();
  });

  test("L1 /rename through the runtime: the daemon's text back; a rename right before quitting is saved", async () => {
    const d = daemon(new Replies(["hi back"]));
    const { store, saver, runtime } = await runtimeOn("rename", d);
    const ctl = runtime.createSession();
    const rename = renameOf(ctl);
    expect(typeof rename).toBe("function");
    await drain(ctl.send("hello"));
    expect(await rename?.call(ctl, "  Mine\tnow ")).toBe("Mine now");
    await runtime.dispose();
    await saver.drain();
    const [record] = (await store.list()).records;
    expect(record?.title).toEqual({ text: "Mine now", source: "user" });
  });

  test("L1 a resumed session seeds its chosen title: the daemon shows it, never regenerates it", async () => {
    const titles = new Replies(["Generated over the rename"]);
    const d = daemon(new Replies(["again"]), titles);
    const resume: SessionRecord = {
      id: "u1",
      cwd: "/tmp/work",
      model: "m",
      createdAt: 1,
      updatedAt: 2,
      title: { text: "My name", source: "user" },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
    };
    const { store, saver, runtime } = await runtimeOn("seed", d, resume);
    await drain(runtime.createSession().send("next"));
    await tick(20);
    expect(d.host.get("u1")?.summary("/tmp/work").title).toBe("My name");
    expect(titles.calls).toBe(0);
    await runtime.dispose();
    await saver.drain();
    expect((await store.load("u1")).status === "ok" && (await store.load("u1"))).toMatchObject({
      record: { title: { text: "My name", source: "user" } },
    });
  });

  test("L1 an older daemon's read-back has no title: the stored one is kept, never re-derived (M5)", async () => {
    const saved: unknown[] = [];
    const inner = {
      async *send() {
        yield { type: "text", delta: "x" };
      },
      readBack: async () => ({ messages: [{ role: "user", content: "q" }] as ChatMessage[] }),
      onTitle: (_l: (n: SessionTitleNotice) => void) => () => {},
    } as unknown as RemoteSession;
    const ctl = persistingController(
      inner,
      (_m, title) => saved.push(title),
      () => {},
      { source: "user", text: "Kept" } as never,
    );
    await drain(ctl.send("go"));
    await ctl.flushed();
    expect(saved).toEqual([{ source: "user", text: "Kept" }]);
  });

  test("L1 a title notice while idle triggers ONE read + save carrying it", async () => {
    const saved: unknown[] = [];
    let notify: (n: SessionTitleNotice) => void = () => {};
    let reads = 0;
    const inner = {
      readBack: async () => {
        reads++;
        return {
          messages: [{ role: "user", content: "q" }] as ChatMessage[],
          title: { text: "Named", source: "model" },
        };
      },
      onTitle: (l: (n: SessionTitleNotice) => void) => {
        notify = l;
        return () => {};
      },
    } as unknown as RemoteSession;
    const ctl = persistingController(inner, (_m, title) => saved.push(title));
    notify({ sessionId: "s", title: "Named", source: "model" });
    await ctl.flushed();
    expect(reads).toBe(1);
    expect(saved).toEqual([{ source: "model", text: "Named" }]);
  });
});

describe("in-process fallback (no daemon)", () => {
  test("L2 its saves carry the resumed record's chosen title through unchanged", async () => {
    const saved: unknown[] = [];
    const { createSession } = inProcessSessions({
      build: () => ({
        agent: new Agent({ model: new Replies(["ok"]), tools: new ToolRegistry(), env }),
        jobs: {
          start: () => {
            throw new Error("unused");
          },
          read: () => undefined,
          kill: () => false,
          list: () => [],
          dispose: () => {},
          onExit: () => () => {},
        },
        tools: new ToolRegistry(),
      }),
      mcpTools: [],
      resume: {
        id: "u1",
        cwd: "/w",
        model: "m",
        createdAt: 1,
        updatedAt: 2,
        title: { text: "Renamed elsewhere", source: "user" },
        messages: [{ role: "user", content: "first" }],
      },
      persist: (snapshot, _createdAt, title?: unknown) =>
        saved.push(recordFromSnapshot(snapshot, { cwd: "/w", model: "m", title } as never).title),
    });
    await drain(createSession().send("more"));
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)).toEqual({ text: "Renamed elsewhere", source: "user" });
  });
});

describe("--resume shows the chosen title", () => {
  test("the picker choice and the [resume] line read the object title's text", async () => {
    const store = new JsonSessionStore(join(dir, "resume"));
    await store.save({
      id: "s1",
      cwd: "/w",
      model: "m",
      createdAt: 1,
      updatedAt: 2,
      title: { text: "Fix login", source: "model" },
      messages: [{ role: "user", content: "hi" }],
    } as unknown as SessionRecord);
    const ok = await resolveResume(store, "s1");
    expect(ok.lines).toEqual(["[resume] s1 — Fix login\n"]);
    // The picker opens with two or more sessions.
    await store.save({
      id: "s0",
      cwd: "/w",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      title: "an older one",
      messages: [{ role: "user", content: "an older one" }],
    });
    let shown: unknown;
    await resolveResume(store, undefined, undefined, async (choices) => {
      shown = choices.map((c) => c.title);
      return null;
    });
    expect(shown).toEqual(["Fix login", "an older one"]);
  });
});
