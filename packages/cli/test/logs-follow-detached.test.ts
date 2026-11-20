/**
 * docs/feat/logs-cmd.md sub-task 3 (`logs-follow-detached`): `logs [-f] <run-name>`
 * picks a detached run out of the laptop kept index (pure `pickRun`) and, for
 * `-f`, dials its pod's resident daemon over the SAME engine exec bridge an
 * `attach` opens — as a READ-ONLY WATCHER that must never look attached, never
 * arm an exit net, and never trust a byte of pod text.
 *
 * Each test names the mutation that turns it red (AGENTS §9).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { entryLines, headerLine } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { ErrorCode, RpcError } from "@tentacle/transport";
import type { DuplexChannel } from "@tentacle/transport";
import { Connection } from "../../daemon/src/connection.ts";
import { SessionHost } from "../../daemon/src/session-host.ts";
import type { EngineExecTarget, EngineHost, EngineRunExecResult } from "../src/engine-host.ts";
import { main } from "../src/index.ts";
import { keptDir, recordKept } from "../src/kept-index.ts";
import { KEPT_SCHEMA_VERSION, type KeptEntry } from "../src/kept.ts";
import { type RunCandidate, pickRun } from "../src/logs-run.ts";
import { acquireResidentLock, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  RUN_STATE_VERSION,
  laptopProc,
  runDirFor,
  writeOwner,
} from "../src/run-state.ts";
import { answerPlacement, isPlacement } from "./placement-fake.ts";

const UID = "7f3c1d20-1111-4222-8333-444455556666";
const CWD = process.cwd();

const entry = (over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: KEPT_SCHEMA_VERSION,
  name: "box",
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  cwd: CWD,
  model: "m",
  created: "2026-11-15T10:00:00.000Z",
  ...over,
});

/** The record a live relay writes (the run's own session, tied to THIS workload). */
const ownerRecord = (created: string): OwnerRecord => ({
  schemaVersion: RUN_STATE_VERSION,
  kind: "relay",
  pid: 4321,
  appVersion: "1",
  sessionId: UID,
  state: "running",
  lastActivityAt: 1,
  autoAccept: false,
  created,
  cwd: CWD,
});

const candidate = (over: Partial<KeptEntry> = {}, live = true): RunCandidate => ({
  entry: entry(over),
  owner: { kind: "owner", owner: ownerRecord(entry(over).created) },
  holderAlive: live,
});

describe("pickRun: which run a WORD names (pure)", () => {
  test("one entry, live: its run, its session, and it is live", () => {
    // Mutation: return `live: true` unconditionally → an ENDED run is dialled
    // (a dead pod's exec, instead of the log the relay saved).
    const picked = pickRun("box", [candidate()]);
    expect(picked).toEqual({ kind: "run", entry: entry(), sessionId: UID, live: true });
    expect(pickRun("box", [candidate({}, false)])).toMatchObject({ live: false });
  });

  test("a name at two places, one of them live: the live one is the run", () => {
    // Mutation: take the first entry → a follower watches another machine's
    // conversation under this name (the reason `WHERE` never comes from a label).
    const local = candidate({ endpoint: "unix:///var/run/docker.sock" }, false);
    const remote = candidate({ endpoint: "ssh://host" }, true);
    expect(pickRun("box", [local, remote])).toMatchObject({
      kind: "run",
      live: true,
      entry: { endpoint: "ssh://host" },
    });
  });

  test("a name at two places, none live (or two live): ambiguous, never a guess", () => {
    // Mutation: pick one of them → `logs -f box` silently follows a run the
    // user did not mean.
    const none = pickRun("box", [
      candidate({ endpoint: "ssh://a" }, false),
      candidate({ endpoint: "ssh://b" }, false),
    ]);
    expect(none.kind).toBe("ambiguous");
    expect(none.kind === "ambiguous" ? none.places : []).toHaveLength(2);
    const both = pickRun("box", [
      candidate({ endpoint: "ssh://a" }),
      candidate({ endpoint: "ssh://b" }),
    ]);
    expect(both.kind).toBe("ambiguous");
  });

  test("another workload's record is not this run's (`created`), so the entry's saved session is used", () => {
    // Mutation: trust any `owner.json` in the run dir → a reused name follows
    // the PREVIOUS run's session (a run dir outlives a name).
    const stale = candidate();
    const previous = {
      ...stale,
      owner: {
        kind: "owner" as const,
        owner: { ...ownerRecord(entry().created), created: "2026-01-01T00:00:00.000Z" },
      },
    };
    const picked = pickRun("box", [
      { ...previous, entry: entry({ sessionId: "99999999-9999-4999-8999-999999999999" }) },
    ]);
    expect(picked).toMatchObject({ sessionId: "99999999-9999-4999-8999-999999999999" });
  });

  test("a kept run nothing has saved yet: no-session; an unknown word: absent", () => {
    expect(pickRun("box", [{ ...candidate(), owner: { kind: "none" }, entry: entry() }]).kind).toBe(
      "no-session",
    );
    // Mutation: fall through to "absent" → `logs -f box` then reads a file
    // named like a run and says the wrong thing (no run vs no session).
    expect(pickRun("other", [candidate()])).toEqual({ kind: "absent" });
  });
});

/** A model that streams one answer: the pod's live turn. */
class Talker implements ModelProvider {
  readonly id = "talker";
  async *stream(): AsyncIterable<{ type: "text"; delta: string } | { type: "done" }> {
    yield { type: "text", delta: "hello from the pod" };
    yield { type: "done" };
  }
}

interface Pod {
  /** The pod's daemon (`SessionHost`) — what a real resident runs. */
  readonly host: SessionHost;
  /** Everything the fake engine was asked to do (mutation evidence). */
  readonly calls: string[];
  readonly hostFor: (kept: KeptEntry) => EngineHost;
}

/**
 * A fake engine: `openExec` hands back the pod side of an in-memory pair whose
 * other end IS a `SessionHost` (a resident daemon), and every lifecycle call is
 * recorded — `remove`, `removeBestEffort`, `create`: a follower must make NONE.
 * The session is opened by a DRIVER connection (the run's TUI), so `attached`
 * is 1 before the follower arrives and must stay 1.
 */
async function pod(
  options: {
    readonly verdict?: string;
    /** The one-shot execs' answers (default: exit 0, nothing printed). */
    readonly runExec?: (target: EngineExecTarget) => Promise<EngineRunExecResult>;
  } = {},
): Promise<Pod> {
  const calls: string[] = [];
  const host = new SessionHost({
    defaultCwd: "/pod/work",
    createAgent: () => ({
      agent: new Agent({
        model: new Talker(),
        tools: new ToolRegistry(),
        env: {
          id: "noop",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
      }),
      permissions: new PermissionBroker(),
    }),
  });
  // The run's own client: it opens the session and stays attached.
  const [driverDaemon, driverClient] = createChannelPair();
  new Connection(driverDaemon, host);
  const driver = new RpcPeer(driverClient, {
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  await driver.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await driver.request("session/open", { sessionId: UID, create: true });
  const engineHost = {
    kind: "docker",
    noun: "container",
    where: "local",
    create: async () => {
      calls.push("create");
    },
    waitForReady: async () => {},
    inspect: async () => {
      calls.push("inspect");
      return { kind: "ready" as const };
    },
    describe: async () => ({ status: "running", labels: {} }),
    dialVerdict: async () => {
      calls.push("dialVerdict");
      return options.verdict === undefined
        ? null
        : ({ kind: "gone", message: options.verdict } as never);
    },
    remove: async () => {
      calls.push("remove");
    },
    removeBestEffort: () => {
      calls.push("removeBestEffort");
    },
    openExec: (target: EngineExecTarget) => {
      calls.push(`exec:${target.name}:${target.command.join(" ")}`);
      const [daemonCh, clientCh] = createChannelPair();
      new Connection(daemonCh, host);
      return clientCh as DuplexChannel;
    },
    runExec:
      options.runExec ??
      (async (target: EngineExecTarget) => {
        calls.push(
          `runexec:${isPlacement(target.command) ? "placement" : target.command.join(" ")}`,
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    execError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  } as unknown as EngineHost;
  return { host, calls, hostFor: () => engineHost };
}

let root = "";
let configDir = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "logs-follow-detached-"));
  configDir = join(root, "config");
  process.env.TENTACLE_CONFIG_DIR = configDir;
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  await rm(root, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `main(["logs", …])` with a fake engine host for the run dial. */
async function logs(
  args: string[],
  seams: {
    hostFor?: (kept: KeptEntry) => EngineHost;
    signal?: AbortSignal;
    /** Sees each stdout/stderr chunk as it is written: wait on the follower's OWN
     * output (its `watching` line, a pod exec), never on a duration. */
    onOut?: (text: string) => void;
    onErr?: (text: string) => void;
  } = {},
): Promise<Run> {
  let out = "";
  let err = "";
  const code = await main(["bun", "cli", "logs", ...args], {
    out: (text) => {
      out += text;
      seams.onOut?.(text);
    },
    err: (text) => {
      err += text;
      seams.onErr?.(text);
    },
    terminal: { stdin: false, stdout: false },
    colour: false,
    ...(seams.hostFor !== undefined ? { logsHostFor: seams.hostFor } : {}),
    ...(seams.signal !== undefined ? { logsSignal: seams.signal } : {}),
  });
  return { code, out, err };
}

/**
 * Write a session's laptop log (`<configDir>/sessions/<projectKey>/<uid>.jsonl`):
 * what a detached run's relay SAVED here, which is all `--tail` reads (the pod
 * keeps no history, AGENTS §7).
 */
async function writeLaptop(id: string): Promise<void> {
  const { projectKey } = await import("@tentacle/agent");
  const dir = join(configDir, "sessions", projectKey(CWD));
  await mkdir(dir, { recursive: true });
  let seq = 0;
  let prev: string | undefined;
  const next = (body: Record<string, unknown>) => {
    seq++;
    const withIds = { ...body, seq, id: `t/${seq}`, ...(prev ? { prev } : {}), ts: 1000 };
    prev = withIds.id;
    return withIds;
  };
  const entries = [
    next({ type: "base", critical: true, inc: "t", reason: "create", count: 0 }),
    next({ type: "turn_start", turnId: "t1" }),
    next({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
  ];
  await writeFile(
    join(dir, `${id}.jsonl`),
    `${headerLine({ id, cwd: CWD, model: "m", createdAt: 1 })}${entryLines(entries as never)}`,
  );
}

/** Record the run in the laptop kept index, and (optionally) hold its lock = a live run. */ /** Record the run in the laptop kept index, and (optionally) hold its lock = a live run. */
async function kept(keptEntry: KeptEntry, live: boolean): Promise<void> {
  recordKept(keptDir(configDir), keptEntry);
  const dir = runDirFor(configDir, keptEntry);
  await mkdir(dir, { recursive: true });
  if (!live) {
    return;
  }
  // The lock file IS the liveness fact the follower reads (`lockHolder`): held
  // by this test process, exactly as a relay or a TUI of the run holds it.
  acquireResidentLock(dir, laptopProc);
  expect(lockHolder(dir, laptopProc)).not.toBeNull();
  writeOwner(dir, ownerRecord(keptEntry.created));
}

describe("logs -f <run-name>: the pod's watcher", () => {
  test("it dials the pod's resident through the exec bridge and follows live, unattached", async () => {
    // Mutations: open a session first (`session/open`) → the follower counts as
    // an attached client in `session/list` and the relay's "in use" read; or
    // skip the bridge's own command → it execs something the pod cannot run.
    const name = "box-live";
    await kept(entry({ name }), true);
    const p = await pod();
    const attachedBefore = p.host.get(UID)?.attachedCount ?? 0;
    expect(attachedBefore).toBe(1);
    const watching = Promise.withResolvers<void>();
    const run = logs([name, "-f", "--json"], {
      hostFor: p.hostFor,
      // Wait on the follower's own `watching` line, never on a 40 ms fence: the
      // dial (config read, index lookup, the exec bridge) is a lot of real I/O to
      // assume done in 40 ms, and under load it was not — `p.calls` was still empty.
      onErr: (text) => {
        if (text.includes(`watching ${UID}`)) watching.resolve();
      },
    });
    await watching.promise;
    // The follower is a watcher only: the session has no attachment of ours.
    expect(p.host.get(UID)?.attachedCount).toBe(attachedBefore);
    expect(p.calls).toContain(
      `exec:${name}:${"/usr/local/bin/tentacle"} serve --bridge --model-proxy`,
    );
    p.host.close(UID);
    const done = await run;
    expect(done.code).toBe(0);
    const kinds = done.out
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(kinds).toContain("closed");
    expect(done.err).toContain(`watching ${UID}`);
    // A follower never touches the workload's life: no create, no delete, no net.
    expect(
      p.calls.filter((call) => ["create", "remove", "removeBestEffort"].includes(call)),
    ).toEqual([]);
  }, 15_000);

  test("the bridge runs the binary the placement probe finds, not a guessed path (docs/fix/inject-bin-dir-probe.md Q2)", async () => {
    // Mutation: `logs` keeps `${binDir ?? "/usr/local/bin"}/tentacle` → it execs a
    // binary `run` never installed (it picked $HOME/.local/bin itself).
    const name = "box-home";
    await kept(entry({ name }), true);
    const p = await pod({
      runExec: (target) =>
        answerPlacement(
          target.command[2] ?? "",
          async (command) => {
            if (command[0] === "sh") {
              return {
                exitCode: 0,
                stdout: "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2\n",
                stderr: "",
              };
            }
            return command[0] === "/home/u/.local/bin/tentacle"
              ? { exitCode: 0, stdout: "tentacle 1.2.3\n", stderr: "" }
              : { exitCode: 127, stdout: "", stderr: "not found" };
          },
          {
            home: "/home/u",
            dirs: { "/usr/local/bin": "write" },
            binaries: ["/home/u/.local/bin/tentacle"],
          },
        ),
    });
    const watching = Promise.withResolvers<void>();
    const run = logs([name, "-f", "--json"], {
      hostFor: p.hostFor,
      onErr: (text) => {
        if (text.includes(`watching ${UID}`)) watching.resolve();
      },
    });
    await watching.promise;
    expect(p.calls).toContain(
      `exec:${name}:/home/u/.local/bin/tentacle serve --bridge --model-proxy`,
    );
    p.host.close(UID);
    expect((await run).code).toBe(0);
  }, 15_000);

  test("an ended run is NOT dialled: its saved log is followed, and it says so", async () => {
    // Mutation: dial whenever an index entry exists → `logs -f` on an ended run
    // execs into a dead workload (or an unrelated live one) instead of reading
    // the copy the relay kept.
    const name = "box-ended";
    await kept(entry({ name, sessionId: UID }), false);
    const p = await pod();
    const run = logs([name, "-f"], { hostFor: p.hostFor });
    const done = await run;
    expect(p.calls).toEqual([]);
    expect(done.err).toContain("has ended");
    // No laptop copy of that session exists here, so the read is refused by id
    // (never a dial): the point is which PATH it took.
    expect(done.err).toContain(UID);
    expect(done.code).toBe(1);
  });

  test("pod text cannot reach the terminal raw (a run name with an escape)", async () => {
    // Mutation: print the name with `${name}` → a pod- or engine-supplied ESC
    // reaches the terminal (AGENTS §7: a pod is not trusted).
    const name = "box\u001b[31m";
    await kept(entry({ name }), true);
    const p = await pod();
    const run = logs([name, "-f"], { hostFor: p.hostFor });
    await new Promise((done) => setTimeout(done, 40));
    p.host.close(UID);
    const done = await run;
    expect(done.err).not.toContain("\u001b");
  }, 15_000);

  test("a gone workload is refused in the engine's words, and no exec runs", async () => {
    // Mutation: skip `dialVerdict` → an exec storm against a dead pod.
    const name = "box-gone";
    await kept(entry({ name }), true);
    const p = await pod({ verdict: 'container "box-gone" is exited' });
    const done = await logs([name, "-f"], { hostFor: p.hostFor });
    expect(done.code).toBe(1);
    expect(done.err).toContain("is exited");
    expect(p.calls).toEqual(["dialVerdict"]);
  });

  test("an ambiguous name is refused, naming the places, and nothing is dialled", async () => {
    // Mutation: pick the first match → another machine's conversation.
    const name = "box-two";
    recordKept(keptDir(configDir), entry({ name, endpoint: "ssh://a" }));
    recordKept(keptDir(configDir), entry({ name, endpoint: "ssh://b" }));
    const p = await pod();
    const done = await logs([name, "-f"], { hostFor: p.hostFor });
    expect(done.code).toBe(1);
    expect(done.err).toContain("none of them is live");
    expect(p.calls).toEqual([]);
  });

  test("a pod running an older tentacle says so (no session/watch), exit 1", async () => {
    // Mutation: swallow MethodNotFound → `logs -f box` sits on an empty stream
    // with no word about why nothing arrives (a pod binary older than this laptop).
    const name = "box-old";
    await kept(entry({ name }), true);
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onNotification: () => {},
      onRequest: async (method) =>
        method === "initialize"
          ? { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { tools: true } }
          : Promise.reject(new RpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`)),
    });
    const host = {
      dialVerdict: async () => null,
      openExec: () => clientCh as DuplexChannel,
    } as unknown as EngineHost;
    const done = await logs([name, "-f"], { hostFor: () => host });
    expect(done.code).toBe(1);
    expect(done.err).toContain("too old");
  });

  test("a kept run with no session yet is refused (nothing was saved)", async () => {
    // Mutation: read the "newest" session instead → `logs -f box` shows an
    // unrelated conversation.
    const name = "box-empty";
    recordKept(keptDir(configDir), entry({ name }));
    const p = await pod();
    const done = await logs([name, "-f"], { hostFor: p.hostFor });
    expect(done.code).toBe(1);
    expect(done.err).toContain("has no session yet");
    expect(p.calls).toEqual([]);
  });
});

describe("logs --tail <run-name>: the laptop copy the relay saved", () => {
  test("it reads the run's session FILE, and never dials the pod", async () => {
    // Mutation: dial for `--tail` too (or ignore the run and look for a file
    // named like it) → a one-shot read of a detached run's log needs a live
    // pod, when the relay already keeps the copy on this laptop.
    const name = "box-tail";
    // The run's session is the one its RECORD names (a run dir outlives a name).
    await kept(entry({ name }), true);
    await writeLaptop(UID);
    const p = await pod();
    const done = await logs([name, "--tail", "5"], { hostFor: p.hostFor });
    expect(done.code).toBe(0);
    expect(p.calls).toEqual([]);
    expect(done.err).toContain(`${UID}.jsonl`);
    expect(done.out).toContain("turn end t1");
  });
});
