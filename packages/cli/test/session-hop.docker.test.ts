/**
 * docs/feat/session-hop.md slice H7 — the LIVE hop, end to end, against a real
 * docker/podman engine. Opt-in: skipped unless `TENTACLE_DOCKER_TESTS=1`, so the
 * normal suite never needs an engine (an opt-in skip, not a failure — AGENTS §6).
 *
 * What it proves, and nothing weaker:
 *
 *   1. local → container: the agent's `shell` call runs INSIDE the container, and
 *      the file it writes is at the SAME path on the laptop — the cwd really is
 *      bind-mounted (decision 1), not copied;
 *   2. the whole conversation is ONE `<uid>.jsonl` on the laptop, the uid
 *      unchanged, and the file holding both places' turns;
 *   3. back to local with `keep: false`: the verified delete removes the
 *      container, and the laptop index entry goes with it;
 *   4. what the hop created was in the laptop index with the `hop` mark (D5).
 *
 * The model is a local OpenAI-compatible mock: a pod reaches it THROUGH the
 * laptop (`model/stream` over RPC, AGENTS §7), so the row needs no key and no
 * network. The pod binary is this tree's (`TENTACLE_POD_BIN`, or a `dev` build),
 * exactly as `run` resolves it.
 *
 * Run it:
 *
 *   TENTACLE_DOCKER_TESTS=1 bun test packages/cli/test/session-hop.docker.test.ts
 *   # a podman machine, or a remote engine over ssh, works the same way:
 *   TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_CONTEXTS=podman \
 *     bun test packages/cli/test/session-hop.docker.test.ts
 *
 * Image: `TENTACLE_SESSION_HOP_IMAGE` ?? `TENTACLE_DOCKER_IMAGE` ??
 * `debian:stable-slim`. NOT `busybox`: the injected pod binary is glibc-linked
 * and `attachEngineRuntime`'s preflight refuses a musl image by name (its own
 * message says which), so a busybox default would report an engine constraint as
 * a hop bug.
 *
 * The folder a hop mounts is REAL and must be shared with the engine: on a
 * podman machine (macOS) only `$HOME` is, so the live row works in the repo's
 * gitignored scratch (`.tentacle/tmp/session-hop/`, AGENTS §6) and falls back to
 * `os.tmpdir()` when there is no repo — where a Linux engine has no such limit.
 * A logical path under a symlink (`/var` → `/private/var` on macOS) is resolved
 * FIRST: the mount is planned at the same path on both sides, and a logical
 * source with a real destination is a path the container's filesystem lacks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import { buildEngineHost, keptLocation } from "../src/engine-select.ts";
import { createHopLeave } from "../src/hop-leave.ts";
import { type HopEngineHost, createHopTargets } from "../src/hop-targets.ts";
import { keptDir, readKept } from "../src/kept-index.ts";
import { type LocalRuntime, createLocalRuntime } from "../src/local-runtime.ts";
import { configuredModelProvider } from "../src/model-provider.ts";
import { hopSession } from "../src/session-hop.ts";
import { SessionSaver } from "../src/session-saver.ts";

const ENABLED = process.env.TENTACLE_DOCKER_TESTS === "1";
const IMAGE =
  process.env.TENTACLE_SESSION_HOP_IMAGE ??
  process.env.TENTACLE_DOCKER_IMAGE ??
  "debian:stable-slim";

let workDir: string;
let configDir: string;
let model: ReturnType<typeof Bun.serve>;

/** Drain an event stream (a turn), so nothing is left in flight. */
const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/**
 * The mock model. It decides from the REQUEST, never from a call counter: the
 * origin's turn and the target's turn are two clients of the same endpoint, and
 * a counter would hand the tool-call script to whichever spoke first (it did,
 * and the row then "found" no file while the container was fine).
 *
 * `use the shell` → one `shell` call writing `file` in the cwd; anything else →
 * one line of text.
 */
function mockModel(file: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string; content: unknown }[] };
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
      const wantsShell = String(lastUser?.content ?? "").includes("use the shell");
      const events = wantsShell
        ? [
            {
              choices: [
                {
                  delta: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        function: {
                          name: "shell",
                          // `cwd` is the mounted folder ITSELF: the pod daemon's
                          // own cwd is `/` (the image's), so a relative path would
                          // land outside the workspace and prove nothing.
                          arguments: `{"command":"printf hopped > hop-live.txt","cwd":"${dirname(file)}"}`,
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ delta: { content: "noted" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ];
      const sse = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

beforeAll(async () => {
  workDir = realpathSync(await mkdtemp(join(scratchRoot(), "live-")));
  mkdirSync(workDir, { recursive: true });
  configDir = await mkdtemp(join(tmpdir(), "session-hop-live-cfg-"));
  model = mockModel(join(workDir, "hop-live.txt"));
});

/** The repo's gitignored scratch when there is one (`$HOME`-side), else the tmpdir. */
function scratchRoot(): string {
  const dir = join(process.cwd(), ".tentacle", "tmp", "session-hop");
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return tmpdir();
  }
}

afterAll(async () => {
  model.stop(true);
  await rm(workDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

/**
 * The config a hop reads: docker, the cwd bind-mounted, and the MOCK model as
 * this laptop's provider (the fields `loadConfig` fills from `config.jsonc`).
 */
function hopConfig(): TentacleConfig {
  return {
    cwd: workDir,
    configDir,
    model: "hop-live",
    provider: "openai",
    baseURL: `http://localhost:${model.port}/v1`,
    apiKey: "test-key",
    models: {},
    subagentModels: {},
    selectableModels: [],
    contextWindow: 128000,
    contextAwareness: { enabled: true, stepPercent: 1 },
    contextReset: { enabled: true, maxPerMessage: -1 },
    contextPrune: {
      enabled: false,
      pruneAtPercent: 60,
      minGainPercent: 15,
      keepRecentRounds: 6,
      pruneOutputChars: 2000,
    },
    toolExecution: { mode: "read-only", maxParallel: 1 },
    engine: "docker",
  } as unknown as TentacleConfig;
}

/**
 * The real docker/podman host, exactly what `main.ts` hands a hop
 * (`hopEngineHost`): the ONE builder `run` uses, with the locators the kept entry
 * records. A hand-made `{}` there would write an entry with no location, which
 * `readKept` then refuses.
 */
function liveHost(): HopEngineHost {
  const built = buildEngineHost("docker", {});
  return {
    host: built.host,
    ...(built.endpoint === undefined ? {} : { endpoint: built.endpoint }),
    locators: keptLocation("docker", built, { context: undefined, insecureTcp: false }),
  };
}

/** The origin: a local worker runtime over an in-memory daemon (`run`'s shape). */
async function localOrigin(
  config: TentacleConfig,
  broker: PermissionBroker,
  saver: SessionSaver,
): Promise<LocalRuntime> {
  const provider = configuredModelProvider(config);
  const server = new SessionHost({
    defaultCwd: workDir,
    createAgent: () => ({
      agent: new Agent({
        model: provider,
        tools: new ToolRegistry().register(shellTool),
        env: {
          id: "live",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
      }),
      permissions: new PermissionBroker(),
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, server);
  return createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: broker,
    saver,
    cwd: workDir,
    model: config.model,
    resume: null,
  });
}

const filesOf = async (): Promise<string[]> => {
  const found = await readdir(join(configDir, "sessions"), { recursive: true }).catch(() => []);
  return found
    .map(String)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".aside"))
    .sort();
};

/** The workload's name from the place the build reported. */
function workloadName(place: { readonly kind: string; readonly name?: string }): string {
  if (place.kind !== "workload" || place.name === undefined || place.name === "") {
    throw new Error("the hop built no named workload");
  }
  return place.name;
}

describe(`live session hop (opt-in: TENTACLE_DOCKER_TESTS=1) — image ${IMAGE}`, () => {
  test.skipIf(!ENABLED)(
    "local → container → local: the folder is shared, one uid, one .jsonl, --rm removes the container",
    async () => {
      const broker = new PermissionBroker(async () => ({ allowed: true, scope: "once" }));
      const store = new LogSessionStore(join(configDir, "sessions"));
      const saver = new SessionSaver(store, () => {});
      const notices: string[] = [];
      const statuses: string[] = [];
      const config = hopConfig();
      const build = createHopTargets({
        config,
        shared: { permissions: broker, saver },
        status: (line) => statuses.push(line),
        notify: (text) => notices.push(text),
        host: () => liveHost(),
        defaultImage: () => IMAGE,
      });

      // ---- hop 1: local → container (a kept, hop-owned workload) ---------
      const origin = await localOrigin(config, broker, saver);
      const ctl = origin.createSession();
      await drain(ctl.send("hello from the laptop"));
      await ctl.flushed();
      await saver.drain();
      await store.drain();
      const uid = ctl.sessionId;
      if (uid === null || uid === undefined) {
        throw new Error("no uid on the origin session");
      }

      const out = await hopSession(
        origin,
        { spec: { target: "container", keep: true }, sessionId: uid },
        { build: (spec, id) => build(spec, id), load: (id) => store.load(id) },
      );
      if (out.kind !== "moved") {
        // A live engine that cannot run the image is a real failure of this
        // test, never a skip: the opt-in says an engine is there.
        throw new Error(`local → container failed: ${out.notice}\n${notices.join("\n")}`);
      }
      const name = workloadName(out.built.place);
      // D5: what the hop created is in the laptop index, marked as a hop's own.
      const index = readKept(keptDir(configDir));
      const entry = index.entries.find((e) => e.entry.name === name);
      expect(entry?.entry.hop).toBe(true);
      expect(entry?.entry.cwd).toBe(workDir);

      // The target's turn runs INSIDE the container, through the real daemon the
      // hop built (its model is the laptop's, over `model/stream`).
      // The hop's own seeded controller (session-hop-live F2): the target's
      // `createSession` now mints a fresh session — the seed is claimed.
      const inContainer = out.controller;
      expect(inContainer.sessionId).toBe(uid);
      await drain(inContainer.send("use the shell"));
      await inContainer.flushed();
      await saver.drain();
      await store.drain();
      // The container really holds the folder: the file the agent's shell wrote
      // INSIDE it is on the laptop at the SAME path (the bind mount, decision 1).
      expect(await Bun.file(join(workDir, "hop-live.txt")).text()).toBe("hopped");

      // ---- hop 2: container → local, deleting what the hop created --------
      const back = await hopSession(
        out.built.runtime,
        { spec: { target: "local", keep: false }, sessionId: uid },
        {
          // `local` in a TEST process: `startWorkerRuntime` spawns a real Worker,
          // which a test runner does not have — so the row builds the same
          // in-memory runtime the origin is (`createLocalRuntime` over a
          // `SessionHost`), which is exactly what the plan's own hop fixtures do.
          build: (spec, id) =>
            spec.target === "local"
              ? localOrigin(config, broker, saver).then((runtime) => ({
                  kind: "built" as const,
                  built: {
                    runtime,
                    place: { kind: "local" as const },
                    folder: "shared",
                    daemonInPod: false,
                    preexisting: false,
                    rollback: () => runtime.dispose(),
                  },
                }))
              : build(spec, id),
          load: (id) => store.load(id),
          // The D5 decision the CLI's `hop-feed` makes, through the verified
          // delete: only with `keep: false`, and only an entry the laptop marked.
          afterLeave: async (spec) =>
            createHopLeave({
              dir: keptDir(configDir),
              locators: () => liveHost().locators,
              hostFor: () => liveHost().host,
            })({ kind: "workload", engine: "docker", name }, spec.keep !== false),
        },
      );
      expect(back.kind).toBe("moved");
      expect(back.kind === "moved" ? back.notice : "").toContain("removed");

      // ONE file at the SAME uid, holding both places' turns.
      expect(await filesOf()).toEqual([`${uid}.jsonl`]);
      const loaded = await store.load(uid);
      const history =
        loaded.status === "ok"
          ? loaded.record.messages.map((m) => String(m.content)).join(" | ")
          : "";
      expect(history).toContain("hello from the laptop");
      expect(history).toContain("use the shell");

      // And the container is GONE — the engine does not describe it any more.
      expect(
        await liveHost()
          .host.describe(name)
          .catch(() => null),
      ).toBeNull();
      // Nothing left behind: the index entry went with the delete.
      expect(readKept(keptDir(configDir)).entries).toHaveLength(0);
      expect(statuses.length).toBeGreaterThan(0);
    },
    300_000,
  );
});
