/**
 * docs/feat/session-hop.md slice H3 — the TUI's half of a hop: props (`hop`,
 * `targetFeed`), the turn boundary (D4), the switching latch, the transient
 * status row, and the swap with `keepTranscript`.
 *
 * The property this file is about (the plan's own wording): after a hop, **the
 * transcript rows are identical and at the same positions**; only the badge and
 * the one notice differ. Everything effectful is a fake `HopFeed` — the App
 * never builds a runtime, so nothing here dials anything.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  App,
  type HopFeed,
  type HopRun,
  type HopTargetView,
  type SessionController,
} from "../src/App.tsx";
import { HOP_QUEUED_NOTICE, hopStep, parseHopCommand } from "../src/hop-command.ts";
import { hopStatusRow } from "../src/hop-status.ts";
import {
  autoApproves,
  buildPermissionChoices,
  permissionDetailLines,
  permissionShowsCwd,
} from "../src/permission-ui.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/** The frame's rows, without the trailing blank ones Ink pads to the height. */
function rows(frame: string | undefined): string[] {
  const lines = strip(frame).split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Two sessions over the same scripted history: the one the App starts on and the
 * one a hop hands it. Their `send` yields the same events, so the transcript is
 * the SAME rows — which is the point: a swap must not move them.
 */
function session(history: string[], log: { sends: string[] }): SessionController {
  return {
    async *send(prompt) {
      log.sends.push(prompt);
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch() {
      return () => {};
    },
    async openForReset() {},
    // The rows the session starts with (a `history` activity is the only way the
    // App learns them without a turn: `openForReset` + `watch` keep this honest).
    ...(history.length > 0 ? {} : {}),
  };
}

/** A `HopFeed` driven by hand: `start` records, and the test resolves `done`. */
function fakeHop(opts: { fail?: string } = {}) {
  const started: string[] = [];
  const cancelled: number[] = [];
  const status: Array<(line: string | null) => void> = [];
  let settle: ((outcome: Awaited<HopRun["done"]>) => void) | null = null;
  const feed: HopFeed = {
    label: (spec) => (spec.target === "local" ? "local" : "docker:box"),
    start(spec) {
      started.push(spec.target);
      const done = new Promise<Awaited<HopRun["done"]>>((resolve) => {
        settle = resolve;
      });
      if (opts.fail !== undefined) {
        // A failing hop settles at once with the one line (never rejects).
        queueMicrotask(() => settle?.({ failed: opts.fail ?? "" }));
      }
      return {
        onStatus(listener) {
          status.push(listener);
          return () => {
            const at = status.indexOf(listener);
            if (at >= 0) {
              status.splice(at, 1);
            }
          };
        },
        done,
      };
    },
    cancel() {
      cancelled.push(1);
    },
  };
  return {
    feed,
    started,
    cancelled,
    status,
    /** Report a phase line, as the orchestrator's status sink would. */
    phase: (line: string | null) => {
      for (const listener of [...status]) {
        listener(line);
      }
    },
    settle: (outcome: Awaited<HopRun["done"]>) => settle?.(outcome),
  };
}

function feedOf(view: HopTargetView) {
  let current = view;
  const listeners = new Set<(v: HopTargetView) => void>();
  return {
    feed: {
      current: () => current,
      onTarget(listener: (v: HopTargetView) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    /** What the host's `onSwap` announces after a commit. */
    announce(next: HopTargetView) {
      current = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
  };
}

async function type(stdin: { write(d: string): void }, text: string, wait = 60) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(wait);
}

describe("H3 the pure turn boundary (`hopStep`)", () => {
  test("a `/move` during a running turn is QUEUED, not started (D4)", () => {
    // Mutation: return `start` when running → this row fails.
    const step = hopStep({
      parse: parseHopCommand("/move container"),
      available: true,
      hopping: false,
      hopQueued: false,
      running: true,
      queued: 0,
    });
    expect(step).toEqual({
      kind: "queue",
      spec: { target: "container", keep: true },
    });
  });

  test("a `/move` with the daemon's queue non-empty is queued too (queued messages run first)", () => {
    const step = hopStep({
      parse: parseHopCommand("/move local --rm"),
      available: true,
      hopping: false,
      hopQueued: false,
      running: false,
      queued: 2,
    });
    expect(step.kind).toBe("queue");
  });

  test("idle and empty: it starts now", () => {
    const step = hopStep({
      parse: parseHopCommand("/move local"),
      available: true,
      hopping: false,
      hopQueued: false,
      running: false,
      queued: 0,
    });
    expect(step).toEqual({ kind: "start", spec: { target: "local", keep: true } });
  });

  test("not a hop-capable origin: one line, nothing built (D8)", () => {
    const step = hopStep({
      parse: parseHopCommand("/move local"),
      available: false,
      hopping: false,
      hopQueued: false,
      running: false,
      queued: 0,
    });
    expect(step).toEqual({ kind: "notice", text: "not available here" });
  });

  test("malformed args and a second `/move` are one line, never a second build", () => {
    for (const raw of ["/move", "/move sideways", "/move attach docker"]) {
      expect(
        hopStep({
          parse: parseHopCommand(raw),
          available: true,
          hopping: false,
          hopQueued: false,
          running: false,
          queued: 0,
        }).kind,
      ).toBe("notice");
    }
    expect(
      hopStep({
        parse: parseHopCommand("/move local"),
        available: true,
        hopping: true,
        hopQueued: false,
        running: false,
        queued: 0,
      }),
    ).toEqual({ kind: "notice", text: "a move is already running" });
  });

  test("`/move cancel` is a cancel only when something waits or runs", () => {
    const cancel = parseHopCommand("/move cancel");
    expect(
      hopStep({
        parse: cancel,
        available: true,
        hopping: true,
        hopQueued: false,
        running: true,
        queued: 1,
      }),
    ).toEqual({ kind: "cancel" });
    expect(
      hopStep({
        parse: cancel,
        available: true,
        hopping: false,
        hopQueued: true,
        running: false,
        queued: 0,
      }),
    ).toEqual({ kind: "cancel" });
    expect(
      hopStep({
        parse: cancel,
        available: true,
        hopping: false,
        hopQueued: false,
        running: false,
        queued: 0,
      }),
    ).toEqual({ kind: "notice", text: "no move is running" });
  });
});

describe("H3 the transient status row (pure)", () => {
  test("no hop: no row; a hop with no phase yet says where it is going", () => {
    expect(hopStatusRow(null, null, 80)).toBeNull();
    expect(hopStatusRow("docker:box", null, 80)).toBe("moving to docker:box");
    expect(hopStatusRow("docker:box", "", 80)).toBe("moving to docker:box");
  });

  test("the phase is the orchestrator's own words, one line, cut to the width", () => {
    expect(hopStatusRow("docker:box", "moving to docker:box — saving the session", 80)).toBe(
      "moving to docker:box — saving the session",
    );
    // An engine's text: control bytes gone, never a second row.
    expect(hopStatusRow("docker:box", "a\nb\x1b[2Jc", 80)).toBe("a b [2Jc");
    expect(hopStatusRow("docker:box", "x".repeat(100), 20)).toHaveLength(20);
  });
});

describe("H4 the `session_hop` dialog (D6/D9): two ways to answer, never a standing approval", () => {
  const hopReq = {
    kind: "session_hop" as const,
    tool: "move_session",
    level: "ask" as const,
    title: "Move this session into a container?",
    detail: "docker: /home/me/work mounted read-write",
    input: null,
  };

  test("auto-accept NEVER answers it (mutation: drop the guard → this fails)", () => {
    expect(autoApproves(hopReq)).toBe(false);
    expect(autoApproves(hopReq, true)).toBe(false);
    // A tool ask is still answered, so the row is about the KIND, not about `own`.
    expect(autoApproves({ ...hopReq, kind: "tool" })).toBe(true);
  });

  test("the menu is Yes-once / No (+ a reply where the asker takes one) — never `always`", () => {
    const choices = buildPermissionChoices(hopReq);
    expect(choices.map((c) => c.label)).toEqual(["Yes, move it", "No"]);
    expect(choices[0]?.response).toEqual({ allowed: true, scope: "once" });
    expect(choices[1]?.response).toEqual({ allowed: false });
    // No "don't ask again" of ANY kind (D9: an approval is never inherited).
    expect(choices.some((c) => c.response.scope === "session")).toBe(false);
    const withReply = buildPermissionChoices({ ...hopReq, reply: { maxChars: 500 } });
    expect(withReply.map((c) => c.label)).toContain("No, let's talk about it");
  });

  test("the detail is shown line by line, and no cwd row is drawn for it", () => {
    expect(permissionDetailLines({ ...hopReq, detail: "a\nb" })).toEqual(["a", "b"]);
    expect(permissionShowsCwd(hopReq)).toBe(false);
  });
});

describe("H3 the App: the transcript rows keep their position across a hop", () => {
  test("only the badge and one notice differ; the draft stays in the input", async () => {
    // Mutation: swap with the transcript reset (`keepTranscript` dropped) → the
    // rows are gone and the positions change.
    const log = { sends: [] as string[] };
    const first = session([], log);
    const second = session([], log);
    const hop = fakeHop();
    const target = feedOf({ place: { kind: "local" }, daemonInPod: false });
    const app = render(
      <App
        createSession={() => first}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        targetFeed={target.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "hello");
    const before = rows(app.lastFrame());
    expect(before.join("\n")).toContain("› hello");

    await type(app.stdin, "/move container", 40);
    expect(hop.started).toEqual(["container"]);
    // The draft is typed WHILE the hop runs: the hop must never touch it.
    app.stdin.write("draft text");
    await delay(30);
    // A hop in flight owns the status row.
    hop.phase("moving to docker:box — preparing the target");
    await delay(40);
    expect(strip(app.lastFrame())).toContain("moving to docker:box — preparing the target");

    hop.settle({
      moved: second,
      view: {
        place: { kind: "workload", engine: "docker", name: "box" },
        badge: { engine: "docker", name: "box" },
        daemonInPod: true,
      },
    });
    target.announce({
      place: { kind: "workload", engine: "docker", name: "box" },
      badge: { engine: "docker", name: "box" },
      daemonInPod: true,
    });
    await delay(80);
    const after = rows(app.lastFrame());
    const frame = after.join("\n");
    // The transcript rows: the same rows, in the same order, at the same place.
    const transcriptBefore = before.filter((r) => r.includes("› hello"));
    const transcriptAfter = after.filter((r) => r.includes("› hello"));
    expect(transcriptAfter).toEqual(transcriptBefore);
    expect(after.indexOf(transcriptAfter[0] ?? "")).toBe(before.indexOf(transcriptBefore[0] ?? ""));
    // Only the badge and the notice differ. The BADGE (the status row) is the
    // exact property — the notice also says `docker:box`, so it cannot prove it.
    const statusAfter = after.find((r) => r.includes("ctx")) ?? "";
    expect(before.find((r) => r.includes("ctx")) ?? "").not.toContain("docker:");
    expect(statusAfter.startsWith("docker:box · ")).toBe(true);
    expect(frame).toContain("Moved to docker:box");
    expect(frame).not.toContain("moving to docker:box —");
    // The draft was never touched by the hop.
    expect(frame).toContain("draft text");
    app.unmount();
  });

  test("a prompt typed MID-HOP goes back to the input, not into a turn", async () => {
    // Mutation: drop `switchingRef.current = true` → the typed text is SENT.
    const log = { sends: [] as string[] };
    const hop = fakeHop();
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "/move container", 40);
    expect(hop.started).toEqual(["container"]);
    await type(app.stdin, "typed mid-hop", 60);
    expect(log.sends).toEqual([]);
    expect(strip(app.lastFrame())).toContain("typed mid-hop");
    app.unmount();
  });

  test("a `/move` during a running turn starts only after its end (D4)", async () => {
    // Mutation: `hopStep` returns `start` when running → `started` is 1 before the
    // turn ends; mutation: the queued hop is never started at the turn's end →
    // `started` stays empty. Both are the same test's two halves.
    const log = { sends: [] as string[] };
    let release: () => void = () => {};
    const slow: SessionController = {
      async *send(prompt) {
        log.sends.push(prompt);
        yield { type: "text", delta: "working" };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "turn_end", reason: "end_turn" };
      },
      watch() {
        return () => {};
      },
    };
    const hop = fakeHop();
    const app = render(
      <App createSession={() => slow} model="m" cwd="/tmp/work" hop={hop.feed} columns={80} />,
    );
    await delay(40);
    await type(app.stdin, "a long turn", 60);
    expect(log.sends).toEqual(["a long turn"]);
    await type(app.stdin, "/move container", 60);
    expect(hop.started).toEqual([]);
    expect(strip(app.lastFrame())).toContain(HOP_QUEUED_NOTICE.replace(/_/g, ""));
    release();
    await delay(160);
    expect(hop.started).toEqual(["container"]);
    app.unmount();
  });

  test("session-hop-live D2: a failure with markdown in an engine's text shows it literally, exactly once", async () => {
    // Mutation: drop `noticeText` at the failure call site → `/_ping` loses its `_`.
    const log = { sends: [] as string[] };
    const text = "not moved: Docker API GET /_ping failed";
    const hop = fakeHop({ fail: text });
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "/move local", 120);
    const frame = strip(app.lastFrame());
    expect(frame.split(text).length - 1).toBe(1);
    app.unmount();
  });

  test("session-hop-live D2: a moved hop is ONE moved line, carrying the note", async () => {
    const log = { sends: [] as string[] };
    const hop = fakeHop();
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "/move container", 60);
    hop.settle({
      moved: session([], log),
      view: { place: { kind: "workload", engine: "docker", name: "box" }, daemonInPod: true },
      note: "the old session did not close",
    });
    await delay(120);
    const frame = strip(app.lastFrame());
    expect(frame.split("Moved to docker:box").length - 1).toBe(1);
    expect(frame).toContain("the old session did not close");
    app.unmount();
  });

  test("on failure the badge and the transcript are unchanged, one notice appears", async () => {
    const log = { sends: [] as string[] };
    const hop = fakeHop({ fail: "not moved: the container could not start" });
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        target={{ engine: "docker", name: "box" }}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "hello");
    const before = rows(app.lastFrame());
    await type(app.stdin, "/move local", 120);
    const after = rows(app.lastFrame());
    const frame = after.join("\n");
    expect(frame).toContain("not moved: the container could not start");
    // Same badge, same transcript rows.
    expect(after.filter((r) => r.includes("› hello"))).toEqual(
      before.filter((r) => r.includes("› hello")),
    );
    expect(frame).toContain("docker:");
    app.unmount();
  });

  test("no `hop` prop: `/move` says it is not available here, and nothing is built (D8)", async () => {
    const log = { sends: [] as string[] };
    const app = render(
      <App createSession={() => session([], log)} model="m" cwd="/tmp/work" columns={80} />,
    );
    await delay(40);
    await type(app.stdin, "/move container", 60);
    expect(strip(app.lastFrame())).toContain("not available here");
    app.unmount();
  });
});

describe("D9 a hop never inherits an approval: auto-accept goes OFF with the move", () => {
  /** A shared auto-accept feed, as a detached run's TUI gets one (B3). */
  function autoFeedOf(initial: boolean) {
    let on = initial;
    const sets: boolean[] = [];
    const feed = {
      current: () => on,
      set: (next: boolean) => {
        on = next;
        sets.push(next);
      },
      onChange: () => () => {},
    };
    return { feed, sets };
  }

  test("ON before the hop: the move turns it off, and the notice says so", async () => {
    // Mutation: drop the `if (wasOn) …` block in `App.startHop` → auto-accept
    // stays on into the NEW runtime, which is the danger D9 exists for: the
    // target's daemon inherits approvals it never asked this user for.
    const log = { sends: [] as string[] };
    const hop = fakeHop();
    const auto = autoFeedOf(true);
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        autoAccept={auto.feed}
        columns={80}
      />,
    );
    await delay(40);
    expect(strip(app.lastFrame())).toContain("auto-accept on");
    await type(app.stdin, "/move container", 60);
    hop.settle({
      moved: session([], log),
      view: { place: { kind: "workload", engine: "docker", name: "box" }, daemonInPod: true },
    });
    await delay(120);
    expect(auto.sets).toEqual([false]);
    const frame = strip(app.lastFrame());
    expect(frame).toContain("auto-accept off");
    // The one notice says it too: the user must not learn it from a prompt.
    expect(frame).toContain("auto-accept is off");
    app.unmount();
  });

  test("OFF before the hop: nothing is flipped (no needless write, no notice)", async () => {
    const log = { sends: [] as string[] };
    const hop = fakeHop();
    const auto = autoFeedOf(false);
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        autoAccept={auto.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "/move container", 60);
    hop.settle({
      moved: session([], log),
      view: { place: { kind: "workload", engine: "docker", name: "box" }, daemonInPod: true },
    });
    await delay(120);
    expect(auto.sets).toEqual([]);
    const frame = strip(app.lastFrame());
    expect(frame).toContain("auto-accept off");
    expect(frame).not.toContain("auto-accept is off");
    app.unmount();
  });

  test("a FAILED hop leaves auto-accept exactly as it was", async () => {
    const log = { sends: [] as string[] };
    const hop = fakeHop({ fail: "not moved: the container could not start" });
    const auto = autoFeedOf(true);
    const app = render(
      <App
        createSession={() => session([], log)}
        model="m"
        cwd="/tmp/work"
        hop={hop.feed}
        autoAccept={auto.feed}
        columns={80}
      />,
    );
    await delay(40);
    await type(app.stdin, "/move container", 120);
    expect(auto.sets).toEqual([]);
    expect(strip(app.lastFrame())).toContain("auto-accept on");
    app.unmount();
  });
});
