/**
 * T10: a WORKER session's artifacts survive a restart (docs/feat/model-artifacts.md
 * D11), and a POD session's do not.
 *
 * A worker daemon persists nothing (AGENTS §7), so after `--resume` its gallery
 * would be empty. The laptop's main thread keeps each version at the save points
 * it already has (`<uid>.artifacts/` beside the log) and the worker's next store
 * is SEEDED from that copy — bytes read lazily, so a resumed session pays for
 * only what it actually opens.
 *
 * The failure this pins is SILENT both ways: without the keep, the resumed
 * gallery is empty and the persisted cards point at nothing; without the
 * exclusion, a pod's artifacts are written under the laptop's store, which §7
 * forbids ("a pod is not trusted").
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import { ArtifactsUnsupportedError } from "@tentacle/client";
import type { ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { type ArtifactSeed, Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import type { ArtifactMeta } from "@tentacle/protocol";
import { ToolRegistry, presentTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { loadConfig } from "../src/config.ts";
import { artifactsToKeep, laptopArtifactSeed } from "../src/laptop-artifacts.ts";
import { LaptopArtifacts, createLocalRuntime, startWorkerRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { laptopSeedFrom } from "../src/worker.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const CONTENT = "# Coverage\n\nhello artifact\n";
const BYTES = new TextEncoder().encode(CONTENT);

/** Turn 1 presents generated `content`; every later turn just ends. */
class Presenter implements ModelProvider {
  readonly id = "presenter";
  private turn = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    const t = this.turn++;
    if (t === 0) {
      yield {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "present",
          arguments: JSON.stringify({
            title: "Coverage",
            content: CONTENT,
            kind: "markdown",
            id: "report",
          }),
        },
      };
    }
    yield { type: "done" };
  }
}

/** A daemon, as the worker's or a pod's own host builds it (`artifactSeed` optional). */
function hostFor(seed?: ArtifactSeed): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/work",
    ...(seed ? { artifactSeed: () => seed } : {}),
    createAgent: (_cwd, ctx) => ({
      agent: new Agent({
        model: new Presenter(),
        tools: new ToolRegistry().register(presentTool),
        env: noopEnv,
        ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/** A controller's artifact read (`SessionController.readArtifact` is optional: absent means unpersisted). */
function readOf(session: { readArtifact?: (m: ArtifactMeta) => Promise<Uint8Array> }) {
  const read = session.readArtifact;
  if (!read) throw new Error("the controller exposes no artifact read");
  return read.bind(session);
}

/** A runtime on `host`, saving into `where` (and, when asked, keeping artifacts there). */
async function runtimeOn(
  host: SessionHost,
  where: string,
  opts: { keep?: true; resume?: SessionRecord | null; uid?: string } = {},
) {
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const store = new LogSessionStore(where);
  const notices: string[] = [];
  const saver = new SessionSaver(store, (text) => notices.push(text));
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver,
    cwd: "/tmp/work",
    model: "m",
    resume: opts.resume ?? null,
    ...(opts.uid ? { sessionId: opts.uid } : {}),
    notify: (text) => notices.push(text),
    ...(opts.keep ? { keepArtifacts: true as const } : {}),
  });
  return { runtime, store, notices, session: runtime.createSession() };
}

/**
 * The worker's own seed wiring, over a store dir: the REAL function
 * (`worker.ts` `laptopSeedFrom`, run by the worker's own handler), so a mutation
 * of it is caught here. Called conditionally rather than with `!` (`AGENTS` §9).
 */
function seedFrom(dir: string): (id: string) => ArtifactSeed | undefined {
  const seed = laptopSeedFrom(dir);
  if (!seed) throw new Error("the worker's seed factory is missing");
  return seed;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "artifacts-durable-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const dirOf = (uid: string) => `${uid}.artifacts`;
const names = async (path: string): Promise<string[]> => readdir(path).catch(() => [] as string[]);

describe("T10 — a worker session's artifacts are kept on the laptop and come back after a resume", () => {
  test("present → turn end → the laptop holds the blob and a manifest line beside the log", async () => {
    const where = join(dir, "keep");
    const { runtime, store, session } = await runtimeOn(hostFor(), where, { keep: true });
    await drain(session.send("show me the report"));
    await session.flushed?.();
    await store.drain();

    const uid = session.sessionId ?? "";
    expect(uid).not.toBe("");
    const manifest = store.artifactManifest(uid);
    expect(manifest === "refused" ? [] : manifest).toEqual([
      expect.objectContaining({ artifactId: "report", version: 1, size: BYTES.length }),
    ]);
    const kept = manifest === "refused" ? [] : manifest;
    const meta = kept[0];
    if (!meta) throw new Error("no artifact kept");
    // The bytes are on disk under the content address, once.
    expect(await names(join(where, dirOf(uid)))).toEqual(
      expect.arrayContaining([meta.sha256, "manifest.jsonl"]),
    );
    await runtime.dispose();
  });

  test("--resume on a fresh daemon: the gallery lists it and its bytes come from the laptop dir", async () => {
    const where = join(dir, "resume");
    const first = await runtimeOn(hostFor(), where, { keep: true });
    await drain(first.session.send("show me the report"));
    await first.session.flushed?.();
    await first.store.drain();
    const uid = first.session.sessionId ?? "";
    // The turn END is where the copy is taken (`session/flushed`), then the
    // worker goes away: nothing of the session is left in memory.
    await first.runtime.dispose();

    const loaded = await first.store.load(uid);
    expect(loaded.status).toBe("ok");
    const record = loaded.status === "ok" ? loaded.record : null;
    if (!record) throw new Error("no saved record");

    // A RESTARTED daemon (a fresh worker host) seeded from the laptop's copy.
    const second = await runtimeOn(hostFor(seedFrom(where)(uid)), where, {
      keep: true,
      resume: record,
    });
    // Not one turn yet — the lazy open a resumed record gets in the TUI
    // (`openSeeded`) — so the list comes from the seed alone, and a read is what
    // makes the daemon touch the disk.
    await second.session.openSeeded();
    const listed = await second.session.listArtifacts();
    expect(listed.artifacts.map((m) => [m.artifactId, m.version])).toEqual([["report", 1]]);
    const meta = listed.artifacts[0];
    if (!meta) throw new Error("no artifact listed after resume");
    expect(Buffer.compare(await readOf(second.session)(meta), BYTES)).toBe(0);
    await second.runtime.dispose();
  });

  test("a kept meta whose blob is gone reads as unavailable, never as bytes", async () => {
    const where = join(dir, "gone");
    const first = await runtimeOn(hostFor(), where, { keep: true });
    await drain(first.session.send("show me the report"));
    await first.session.flushed?.();
    await first.store.drain();
    const uid = first.session.sessionId ?? "";
    const manifest = first.store.artifactManifest(uid);
    const meta: ArtifactMeta | undefined = manifest === "refused" ? undefined : manifest[0];
    if (!meta) throw new Error("no artifact kept");
    await first.runtime.dispose();
    await rm(join(where, dirOf(uid), meta.sha256), { force: true });

    const second = await runtimeOn(hostFor(seedFrom(where)(uid)), where, { keep: true });
    await second.session.openSeeded();
    const listed = await second.session.listArtifacts();
    const seeded = listed.artifacts[0];
    if (!seeded) throw new Error("no artifact listed");
    const failed = readOf(second.session)(seeded).then(
      () => "resolved",
      (error: { data?: { reason?: string } }) => error.data?.reason,
    );
    expect(await failed).toBe("evicted");
    await second.runtime.dispose();
  });

  test("a kept blob that is SHORT of its meta reads as unavailable (never a truncated artifact)", async () => {
    const where = join(dir, "short");
    const first = await runtimeOn(hostFor(), where, { keep: true });
    await drain(first.session.send("show me the report"));
    await first.session.flushed?.();
    await first.store.drain();
    const uid = first.session.sessionId ?? "";
    const manifest = first.store.artifactManifest(uid);
    const meta: ArtifactMeta | undefined = manifest === "refused" ? undefined : manifest[0];
    if (!meta) throw new Error("no artifact kept");
    await first.runtime.dispose();
    const blob = join(where, dirOf(uid), meta.sha256);
    await writeFile(blob, BYTES.subarray(0, BYTES.length - 1));

    const second = await runtimeOn(hostFor(seedFrom(where)(uid)), where, { keep: true });
    await second.session.openSeeded();
    const listed = await second.session.listArtifacts();
    const seeded = listed.artifacts[0];
    if (!seeded) throw new Error("no artifact listed");
    const failed = readOf(second.session)(seeded).then(
      () => "resolved",
      (error: { data?: { reason?: string } }) => error.data?.reason,
    );
    expect(await failed).toBe("evicted");
    await second.runtime.dispose();
  });
});

describe("T10 — a POD runtime writes NOTHING under the laptop store (§7)", () => {
  test("present + save with no keepArtifacts: no artifacts dir, no manifest", async () => {
    const where = join(dir, "pod");
    const { runtime, store, session } = await runtimeOn(hostFor(), where);
    await drain(session.send("show me the report"));
    await session.flushed?.();
    await store.drain();
    const uid = session.sessionId ?? "";
    // The log IS saved (this is the normal laptop store); the artifacts are not.
    expect((await store.load(uid)).status).toBe("ok");
    expect(store.artifactManifest(uid)).toEqual([]);
    expect(await names(join(where, dirOf(uid)))).toEqual([]);
    await runtime.dispose();
  });
});

describe("T10 — the worker is TOLD where the laptop's copy is, and keeps its own", () => {
  test("startWorkerRuntime posts the store dir AND asks the runtime to keep artifacts", async () => {
    // The two plumbing lines the resume path stands on: the worker reads the
    // dir (its side is `laptopSeedFrom`, above), and the main thread keeps it.
    // A fake worker: no handshake, so the start fails at the timeout — the
    // bootstrap it was handed is the assertion.
    const posted: { artifactsDir?: string }[] = [];
    const worker = {
      postMessage: (m: unknown) => void posted.push(m as { artifactsDir?: string }),
      addEventListener: () => {},
      terminate: () => {},
    } as unknown as Worker;
    const config = { cwd: "/tmp/work", model: "m" } as never;
    const failed = startWorkerRuntime(
      config,
      {
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "wire")), () => {}),
        resume: null,
        artifactsDir: "/laptop/sessions",
      },
      () => {},
      { spawn: () => worker, handshakeMs: 20 },
    ).then(
      () => "started",
      (error: Error) => error.name,
    );
    expect(await failed).toBe("WorkerStartError");
    expect(posted[0]?.artifactsDir).toBe("/laptop/sessions");
  });
});

describe("T10 — end to end over the REAL worker boundary", () => {
  // The strongest form of the pin: a real worker daemon (nothing in this test
  // touches `ArtifactStore` or the seed by hand), a real scripted model, and the
  // laptop's own store dir. Mutation: drop `keepArtifacts: true` at the worker's
  // `createLocalRuntime` call, or `artifactsDir` from the bootstrap, or the seed
  // in `laptopSeedFrom` → a test here goes red.
  const sse = (events: unknown[]): string =>
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  const PRESENT = sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_present",
                function: {
                  name: "present",
                  arguments: JSON.stringify({
                    title: "Coverage",
                    content: CONTENT,
                    kind: "markdown",
                    id: "report",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const END = sse([
    { choices: [{ delta: { content: "done" } }] },
    { choices: [{ finish_reason: "stop" }] },
  ]);

  let server: ReturnType<typeof Bun.serve> | undefined;
  let config: never;
  let sessions = "";
  let turn = 0;

  beforeAll(async () => {
    sessions = join(dir, "e2e-sessions");
    const root = await mkdtemp(join(tmpdir(), "artifacts-durable-e2e-"));
    server = Bun.serve({
      port: 0,
      fetch: () => {
        const body = turn++ === 0 ? PRESENT : END;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    config = (await loadConfig({
      cwd: root,
      configDir: join(root, "config"),
      scaffold: false,
      env: {
        HOME: root,
        TENTACLE_MODEL_API_KEY: "k",
        TENTACLE_MODEL_BASE_URL: `http://localhost:${server.port}/v1`,
        TENTACLE_MODEL: "test",
      },
    })) as never;
  });
  afterAll(async () => {
    server?.stop(true);
  });

  const start = (resume: SessionRecord | null) =>
    startWorkerRuntime(
      config,
      {
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(sessions), () => {}),
        resume,
        // The main thread's store dir, exactly as `main.ts` computes it.
        artifactsDir: sessions,
      },
      () => {},
    );

  test("a presented artifact lands in the laptop's `<uid>.artifacts/` and comes back on --resume", async () => {
    const first = await start(null);
    let uid = "";
    try {
      const session = first.createSession();
      for await (const _ of session.send("show me the report")) {
        // consume
      }
      await session.flushed?.();
      uid = session.sessionId ?? "";
    } finally {
      await first.dispose();
    }
    expect(uid).not.toBe("");
    const store = new LogSessionStore(sessions);
    const manifest = store.artifactManifest(uid);
    const kept = manifest === "refused" ? [] : manifest;
    expect(kept.map((m) => m.artifactId)).toEqual(["report"]);
    expect(
      Buffer.compare(
        (await store.readArtifactBlob(uid, kept[0]?.sha256 ?? "", 0, BYTES.length)) ??
          new Uint8Array(),
        BYTES,
      ),
    ).toBe(0);

    const loaded = await store.load(uid);
    if (loaded.status !== "ok") throw new Error("no saved record");
    const second = await start(loaded.record);
    try {
      const session = second.createSession();
      await session.openSeeded();
      const listed = await session.listArtifacts();
      expect(listed.artifacts.map((m) => m.artifactId)).toEqual(["report"]);
      const meta = listed.artifacts[0];
      if (!meta) throw new Error("no artifact listed");
      expect(Buffer.compare(await session.readArtifact(meta), BYTES)).toBe(0);
    } finally {
      await second.dispose();
    }
  }, 60_000);
});

describe("LaptopArtifacts — the laptop half alone", () => {
  const meta = (artifactId: string, sha256: string, size: number): ArtifactMeta => ({
    artifactId,
    version: 1,
    sha256,
    size,
    mimeType: "text/markdown",
    kind: "markdown",
    title: "T",
    callId: "c",
    createdAt: 1,
  });

  test("artifactsToKeep: one sha256 under two ids is fetched once; what is already kept is skipped", () => {
    const a = meta("a", "a".repeat(64), 3);
    const b = meta("b", "a".repeat(64), 3);
    const c = meta("c", "c".repeat(64), 4);
    expect(artifactsToKeep([a], { artifacts: [a, b, c] }).map((m) => m.artifactId)).toEqual(["c"]);
    expect(artifactsToKeep([], { artifacts: [a, b] }).map((m) => m.artifactId)).toEqual(["a"]);
  });

  test("an older daemon (no artifact/list): nothing kept, no notice", async () => {
    const written: string[] = [];
    const notices: string[] = [];
    const artifacts = new LaptopArtifacts({
      kept: () => [],
      list: () => Promise.reject(new ArtifactsUnsupportedError(new Error("unknown method"))),
      read: () => Promise.reject(new Error("never read")),
      write: async (m) => void written.push(m.sha256),
      notice: (t) => notices.push(t),
      saving: () => true,
    });
    await artifacts.save();
    expect(written).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a failing disk: ONE notice however many save points try again", async () => {
    const notices: string[] = [];
    const m = meta("a", "a".repeat(64), 3);
    const artifacts = new LaptopArtifacts({
      kept: () => [],
      list: () => Promise.resolve({ artifacts: [m] }),
      read: () => Promise.resolve(new Uint8Array(3)),
      write: () => Promise.reject(new Error("no space left on device (ENOSPC)")),
      notice: (t) => notices.push(t),
      saving: () => true,
    });
    await artifacts.save();
    await artifacts.save();
    await artifacts.save();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("no space left on device (ENOSPC)");
  });

  test("a refused manifest (a newer tentacle) is never written, and never seeded", async () => {
    const written: string[] = [];
    const m = meta("a", "a".repeat(64), 3);
    // The list RESOLVES: were the refusal not honoured, this would be fetched
    // and written into a dir a newer tentacle owns.
    const artifacts = new LaptopArtifacts({
      kept: () => "refused",
      list: () => Promise.resolve({ artifacts: [m] }),
      read: () => Promise.resolve(new Uint8Array(3)),
      write: async (got) => void written.push(got.sha256),
      notice: () => {},
      saving: () => true,
    });
    await artifacts.save();
    expect(written).toEqual([]);
    // The worker's seed half refuses it too: a meta list we cannot read as ours
    // must never become a gallery.
    const seed = laptopArtifactSeed(
      { artifacts: () => "refused", readArtifact: () => Promise.reject(new Error("never read")) },
      "s",
    );
    expect(seed).toBeUndefined();
  });
});
