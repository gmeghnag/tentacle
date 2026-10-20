/**
 * The parent property (docs/eval/session-reattach.md, decision C) end to end,
 * over REAL daemon objects (`SessionHost` + `Connection` per channel + `Agent`):
 * for every drop point `k` — counted over both directions — and every recovery
 * path, the projected transcript the client holds equals the uninterrupted one
 * at every quiet point and at the end, the applied seqs are contiguous, and the
 * work ran exactly once (model calls, tool runs).
 *
 * Paths: (a) the same client re-attaches with its own `since`; (b) a fresh
 * client (new broker: the app was killed) opens the session; (c) the same
 * client re-attaches with `since` stripped (a resync).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import type { RemoteSession } from "../src/remote-session.ts";
import type { StreamOutput } from "../src/session-reducer.ts";
import { GatedModel, type Step, approver, done, t, tick, until } from "./support/fakes.ts";
import { cutLink, delayOutbound, stripSince } from "./support/link-cutter.ts";
import { type Item, foldEvents, foldOutputs, fromMessages } from "./support/transcript.ts";

type Path = "reattach" | "fresh" | "resync";
/** S1: text, a pause mid-round, a shell call that needs approval, more text; then a second turn. */
const S1: readonly (readonly Step[])[] = [
  [
    t("a"),
    t("b"),
    t("c"),
    { kind: "gate" },
    t("d"),
    {
      kind: "event",
      event: {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      },
    },
    done,
  ],
  [t("e"), t("f"), done],
  [t("g"), t("h"), done],
];

/** S2: a turn, a compaction (its summary is one model call), a turn. */
const S2: readonly (readonly Step[])[] = [
  [t("x"), { kind: "gate" }, t("y"), done],
  [t("summary of x y"), done],
  [t("z"), done],
];

/** Seqs of the updates between resets must step by exactly 1 (no gap, no duplicate). */
function contiguous(log: readonly StreamOutput[]): boolean {
  let last: number | null = null;
  for (const out of log) {
    if (out.kind === "reset") {
      last = null;
    } else if (out.kind === "update") {
      if (last !== null && out.seq !== last + 1) return false;
      last = out.seq;
    }
  }
  return true;
}

interface RunResult {
  readonly frames: number;
  readonly cut: boolean;
  readonly mismatches: string[];
  readonly modelCalls: number;
  readonly toolRuns: number;
  /** The daemon ran turn 1 (false only when the cut beat the prompt frame). */
  readonly started: boolean;
  readonly prompts: number;
}

async function scenario(script: "S1" | "S2", k: number, path: Path): Promise<RunResult> {
  const model = new GatedModel(script === "S1" ? S1 : S2);
  let toolRuns = 0;
  const host = new SessionHost({
    defaultCwd: "/tmp/reattach",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env: {
          id: "e",
          exec: async () => {
            toolRuns += 1;
            return { stdout: "listing", stderr: "", exitCode: 0 };
          },
          readFile: async () => "",
          writeFile: async () => {},
        },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const connect = (): ReturnType<typeof createChannelPair>[1] => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };

  // The observer: attached from the start, never dropped — the reference.
  const observerLog: StreamOutput[] = [];
  const observer = new RemoteClient(connect(), approver().broker);
  await observer.initialize();
  await observer.openSession(undefined, undefined, "S", {
    output: (out) => observerLog.push(out),
    recovered: () => {},
    linkClosed: () => {},
  });

  // The client under test, over a link cut after frame k.
  const link = cutLink(k);
  new Connection(link.daemon, host);
  const main = approver();
  const factory =
    path === "fresh"
      ? undefined
      : async () =>
          // Resync over a slow link: the snapshot request lags, so the stream
          // (and the cut) move between the `open` and its snapshot.
          path === "resync"
            ? stripSince(delayOutbound(connect(), "session/snapshot", 3))
            : connect();
  const client = new RemoteClient(link.client, main.broker, undefined, {
    ...(factory ? { channelFactory: factory } : {}),
    random: () => 0,
  });
  await client.initialize();
  link.arm();
  const session: RemoteSession = client.newSession(undefined, "S");
  const mainLog: StreamOutput[] = [];
  const output = session.output.bind(session);
  session.output = (out: StreamOutput): void => {
    mainLog.push(out);
    output(out);
  };
  let recoveries = 0;
  const recovered = session.recovered.bind(session);
  session.recovered = (info): void => {
    recoveries += 1;
    recovered(info);
  };

  // Path (b): once the link is cut, a fresh client (new broker) opens the session.
  let fresh: { client: RemoteClient; log: StreamOutput[]; ap: ReturnType<typeof approver> } | null =
    null;
  const ensureFresh = async (): Promise<void> => {
    if (path !== "fresh" || !link.cut() || fresh) return;
    const ap = approver();
    const log: StreamOutput[] = [];
    const c = new RemoteClient(connect(), ap.broker);
    fresh = { client: c, log, ap };
    await c.initialize();
    await c.openSession(undefined, undefined, "S", {
      output: (out) => log.push(out),
      recovered: () => {},
      linkClosed: () => {},
    });
  };
  const consumerLog = (): StreamOutput[] => (fresh ? fresh.log : mainLog);
  const reference = (): Item[] => foldOutputs(observerLog);

  const mismatches: string[] = [];
  const check = async (where: string): Promise<void> => {
    await ensureFresh();
    // Compare the RECOVERED state, not the one from before the drop.
    if (path !== "fresh" && link.cut() && !(await until(() => recoveries > 0, 2000))) {
      mismatches.push(`${where}: never recovered`);
    }
    const same = () => JSON.stringify(foldOutputs(consumerLog())) === JSON.stringify(reference());
    if (!(await until(same, 2000))) {
      mismatches.push(
        `${where}: client ${JSON.stringify(foldOutputs(consumerLog()))} != reference ${JSON.stringify(reference())}`,
      );
    }
    if (!contiguous(consumerLog())) mismatches.push(`${where}: seqs not contiguous`);
  };
  const hosted = () => host.get("S");
  const idle = () => hosted()?.running === false;

  // Turn 1.
  const prompt1 = script === "S1" ? "go" : "first";
  const events1: SessionEvent[] = [];
  const turn1 = (async () => {
    for await (const e of session.send(prompt1)) events1.push(e);
  })().then(
    () => "ok",
    (e: Error) => `error: ${e.message}`,
  );

  await until(() => model.waiting || (path === "fresh" && link.cut()));
  const started = (): boolean =>
    observerLog.some((o) => o.kind === "update" && o.update.type === "turn_start");
  if (path === "fresh" && !model.waiting) {
    // Cut before the prompt left this client (frames after k are lost): the
    // turn never starts. The fresh client must show exactly that.
    for (let i = 0; i < 10; i++) await tick();
  }
  const neverStarted = path === "fresh" && !started();
  if (neverStarted) {
    await check("prompt never sent");
  } else {
    await check("at the gate");
    await runRest();
  }
  async function runRest(): Promise<void> {
    model.open();
    if (script === "S1") {
      await until(() => main.pending() > 0 || (fresh?.ap.pending() ?? 0) > 0 || link.cut(), 3000);
      await ensureFresh();
      const ap = (): ReturnType<typeof approver> => fresh?.ap ?? main;
      await until(() => ap().pending() > 0);
      await check("approval pending");
      ap().approve();
    }
    await until(idle);
    await check("turn 1 ended");
    const outcome1 = await Promise.race([turn1, until(() => false, 2000).then(() => "hung")]);
    if (path !== "fresh" && outcome1 !== "ok") mismatches.push(`turn 1: ${outcome1}`);
    if (path !== "fresh" && script === "S1") {
      // The TUI's own fold of its turn (no upsert: a duplicate tool would show).
      const tui = foldEvents([], prompt1, events1);
      if (JSON.stringify(tui) !== JSON.stringify(reference())) {
        mismatches.push(
          `turn 1 TUI fold: ${JSON.stringify(tui)} != ${JSON.stringify(reference())}`,
        );
      }
    }
  }

  if (path !== "fresh") {
    if (script === "S2") {
      await session.compact().catch(() => undefined); // a drop mid-compact rejects (Q9)
      await until(() => model.calls >= 2 && idle());
      await check("after compact");
    }
    const events2: SessionEvent[] = [];
    const outcome2 = await (async () => {
      for await (const e of session.send(script === "S1" ? "again" : "second")) events2.push(e);
    })().then(
      () => "ok",
      (e: Error) => `error: ${e.message}`,
    );
    if (outcome2 !== "ok") mismatches.push(`turn 2: ${outcome2}`);
    await check("end");
    // Bridge: the transcript equals the daemon's own history.
    const history = await observer.snapshot("S");
    const bridged =
      JSON.stringify(foldOutputs(observerLog)) ===
      JSON.stringify(
        fromMessages(history).filter((i) => i.kind !== "assistant" || i.text.trim() !== ""),
      );
    if (!bridged) mismatches.push("bridge: reference != daemon history");
  }

  const result: RunResult = {
    frames: link.count(),
    cut: link.cut(),
    mismatches,
    modelCalls: model.calls,
    toolRuns,
    started: started(),
    prompts:
      main.prompts() + ((fresh as { ap: ReturnType<typeof approver> } | null)?.ap.prompts() ?? 0),
  };
  client.close();
  observer.close();
  (fresh as { client: RemoteClient } | null)?.client.close();
  return result;
}

describe("re-attach property (every drop point, every path)", () => {
  for (const script of ["S1", "S2"] as const) {
    test(`${script}: uninterrupted baseline, then a drop after every frame k — reattach, fresh, resync`, async () => {
      const base = await scenario(script, Number.MAX_SAFE_INTEGER, "reattach");
      expect(base.cut).toBe(false);
      expect(base.mismatches).toEqual([]);
      const calls = base.modelCalls;
      expect(calls).toBe(3);
      expect(base.toolRuns).toBe(script === "S1" ? 1 : 0);
      // The fresh path stops after turn 1 (the new client did not start it): fewer frames.
      const freshBase = await scenario(script, Number.MAX_SAFE_INTEGER, "fresh");
      expect(freshBase.mismatches).toEqual([]);
      const failures: string[] = [];
      for (let k = 1; k <= base.frames; k++) {
        for (const path of ["reattach", "fresh", "resync"] as const) {
          if (path === "fresh" && k > freshBase.frames) continue;
          const r = await scenario(script, k, path);
          const tag = `${script} k=${k} ${path}`;
          if (!r.cut) failures.push(`${tag}: no cut`);
          for (const m of r.mismatches) failures.push(`${tag}: ${m}`);
          const runs = r.started ? 1 : 0;
          if (script === "S1" && r.toolRuns !== runs) {
            failures.push(`${tag}: tool ran ${r.toolRuns}× (turn started: ${r.started})`);
          }
          if (path !== "fresh" && !r.started) failures.push(`${tag}: turn never started`);
          if (path !== "fresh" && r.modelCalls !== calls) {
            failures.push(`${tag}: ${r.modelCalls} model calls`);
          }
          // The dialog survives a drop and a replayed request is never prompted
          // twice (reattach keeps the router; resync retains and dedupes).
          if (script === "S1" && path !== "fresh" && r.prompts !== 1) {
            failures.push(`${tag}: broker prompted ${r.prompts}×`);
          }
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }
});
