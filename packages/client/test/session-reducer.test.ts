import { describe, expect, test } from "bun:test";
import type { SessionUpdateParams } from "@tentacle/protocol";
import {
  MAX_BUFFERED_UPDATES,
  MAX_FORCED_REOPENS,
  type StreamInput,
  type StreamState,
  type StreamStep,
  initialStream,
  reduceStream,
  sinceOf,
} from "../src/session-reducer.ts";

const chunk = (seq: number, text = `c${seq}`): SessionUpdateParams => ({
  sessionId: "S",
  seq,
  update: { type: "agent_message_chunk", content: { type: "text", text } },
});
const frame = (seq: number, update: Record<string, unknown>, mandatory = false) =>
  ({
    sessionId: "S",
    seq,
    ...(mandatory ? { mandatory: true } : {}),
    update,
  }) as SessionUpdateParams;
const upd = (params: SessionUpdateParams, now = 0): StreamInput => ({
  kind: "update",
  params,
  now,
});
const req = (seq: number, requestId: string) =>
  frame(
    seq,
    {
      type: "permission_request",
      requestId,
      toolCallId: "c1",
      tool: "shell",
      title: "t",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    },
    true,
  );
const resolved = (seq: number, requestId: string) =>
  frame(seq, { type: "permission_resolved", requestId, outcome: { outcome: "cancelled" } }, true);

/** Run inputs; return the final state and every output/effect, compacted. */
function run(inputs: readonly StreamInput[], from: StreamState = initialStream) {
  let state = from;
  const out: string[] = [];
  const effects: string[] = [];
  for (const input of inputs) {
    const step: StreamStep = reduceStream(state, input);
    state = step.state;
    for (const o of step.out) {
      if (o.kind === "update") out.push(`${o.seq}:${o.update.type}`);
      else if (o.kind === "reset")
        out.push(`reset(${o.messages.length}, turn=${o.turn}, keep=${o.keepRequests.join("|")})`);
      else if (o.kind === "error") out.push(`error:${o.error.message}`);
      else if (o.kind === "unsupported") out.push(`unsupported:${o.type}`);
      else out.push(o.kind);
    }
    effects.push(...step.effects.map((e) => e.kind));
  }
  return { state, out, effects };
}

const live = (applied: number, epoch = "e1"): StreamState => ({
  ...initialStream,
  phase: "live",
  epoch,
  applied,
});
const openReplay = (epoch = "e1"): StreamInput => ({
  kind: "open_result",
  created: false,
  resync: false,
  epoch,
  now: 0,
});
const openResync: StreamInput = {
  kind: "open_result",
  created: false,
  resync: true,
  epoch: "e1",
  now: 0,
};
const snap = (seq: number, turn: string | null = null, epoch = "e1"): StreamInput => ({
  kind: "snapshot",
  messages: [{ role: "user", content: "hi" }],
  since: { epoch, seq },
  turn,
  now: 0,
});

describe("session stream reducer (pure)", () => {
  test("a new session: an update that beat the open result is buffered, then applied", () => {
    const r = run([
      { kind: "open_sent" },
      upd(chunk(1)),
      { kind: "open_result", created: true, resync: false, epoch: "e1", now: 0 },
      upd(chunk(2)),
    ]);
    expect(r.out).toEqual(["1:agent_message_chunk", "2:agent_message_chunk"]);
    expect(r.state.phase).toBe("live");
    expect(sinceOf(r.state)).toEqual({ epoch: "e1", seq: 2 });
  });

  test("re-attach (replay): arrival order is irrelevant — applied by seq, overlap dropped", () => {
    // Applied up to 3; the replay re-sends 3 (overlap) and live 5 overtakes 4.
    const r = run(
      [
        { kind: "open_sent" },
        upd(chunk(5)),
        upd(chunk(3)),
        upd(chunk(4)),
        upd(chunk(4)), // a duplicate inside the buffer
        openReplay(),
      ],
      { ...live(3), phase: "down" },
    );
    expect(r.out).toEqual(["4:agent_message_chunk", "5:agent_message_chunk"]);
    expect(r.state.applied).toBe(5);
  });

  test("live: a duplicate is dropped; a gap forces a reopen without since", () => {
    const r = run([upd(chunk(3)), upd(chunk(4)), upd(chunk(6))], live(3));
    expect(r.out).toEqual(["4:agent_message_chunk"]);
    expect(r.effects).toEqual(["reopen"]);
    expect(r.state.phase).toBe("resyncing");
    expect(sinceOf(r.state)).toBeUndefined(); // the reopen is a resync
  });

  test("the reopen guard: more than 3 gaps a minute fails the session (visible, no loop)", () => {
    let state = live(1);
    const outs: string[] = [];
    for (let i = 0; i <= MAX_FORCED_REOPENS; i++) {
      const r = run(
        [
          { kind: "open_sent" },
          openResync,
          snap(1),
          upd(chunk(9), i * 1000), // a gap again
        ],
        state,
      );
      state = r.state;
      outs.push(...r.out.filter((o) => o === "failed"));
    }
    expect(outs).toEqual(["failed"]);
    expect(state.phase).toBe("failed");
    // Failed is final: nothing applies any more.
    expect(run([upd(chunk(2))], state).out).toEqual([]);
  });

  test("resync: reset to the snapshot, then only the buffered updates past its cut", () => {
    const r = run(
      [
        { kind: "open_sent" },
        upd(chunk(4)), // ≤ the cut: already in the snapshot
        upd(chunk(6)),
        upd(chunk(5)),
        openResync,
        snap(4, "T1"),
      ],
      { ...live(9, "old"), phase: "down" },
    );
    expect(r.effects).toEqual(["fetch_snapshot"]);
    expect(r.out).toEqual([
      "reset(1, turn=T1, keep=)",
      "5:agent_message_chunk",
      "6:agent_message_chunk",
    ]);
    // A turn resumed after a serve restart has no turn_start: the snapshot names it.
    expect(r.state.turn).toBe("T1");
    expect(sinceOf(r.state)).toEqual({ epoch: "e1", seq: 6 });
  });

  test("resync: a gap right after the cut is a gap too (never a silent hole)", () => {
    const r = run([{ kind: "open_sent" }, upd(chunk(7)), openResync, snap(5)]);
    expect(r.out).toEqual(["reset(1, turn=null, keep=)"]);
    expect(r.effects).toEqual(["fetch_snapshot", "reopen"]);
  });

  test("a replay result under another epoch is treated as a resync (defensive)", () => {
    const r = run([{ kind: "open_sent" }, openReplay("e2")], { ...live(3, "e1"), phase: "down" });
    expect(r.effects).toEqual(["fetch_snapshot"]);
    expect(r.state.phase).toBe("resyncing");
  });

  test("history_replaced is a barrier: later updates wait for the new snapshot", () => {
    const r = run(
      [
        upd(frame(4, { type: "history_replaced", reason: "compact" }, true)),
        upd(chunk(5)),
        upd(chunk(6)),
        snap(5, null, "e2"),
      ],
      live(3),
    );
    expect(r.out).toEqual([
      "4:history_replaced",
      "reset(1, turn=null, keep=)",
      "6:agent_message_chunk",
    ]);
    expect(r.effects).toEqual(["fetch_snapshot"]);
    expect(sinceOf(r.state)).toEqual({ epoch: "e2", seq: 6 });
  });

  test("a barrier inside a replay buffer: what follows it waits for the snapshot", () => {
    const r = run(
      [
        { kind: "open_sent" },
        upd(chunk(4)),
        upd(frame(5, { type: "history_replaced", reason: "compact" }, true)),
        upd(chunk(6)),
        openReplay(),
      ],
      { ...live(3), phase: "down" },
    );
    expect(r.out).toEqual(["4:agent_message_chunk", "5:history_replaced"]);
    expect(r.state.buffer.map((p) => p.seq)).toEqual([6]);
    expect(run([snap(5, null, "e2")], r.state).out).toEqual([
      "reset(1, turn=null, keep=)",
      "6:agent_message_chunk",
    ]);
  });

  test("event classes: unknown display is 'unsupported' once per kind; unknown mandatory and malformed known are errors", () => {
    const r = run(
      [
        upd(frame(2, { type: "progress_bar" })),
        upd(frame(3, { type: "future_mandatory" }, true)),
        upd(frame(4, { type: "agent_message_chunk" })),
        upd(chunk(5)),
        upd(frame(6, { type: "progress_bar", pct: 2 })),
        upd(frame(7, { type: "other_future" })),
      ],
      live(1),
    );
    expect(r.out).toEqual([
      "unsupported:progress_bar",
      'error:unknown mandatory update "future_mandatory": the daemon is newer than this client — update tentacle',
      "error:malformed agent_message_chunk update from the daemon",
      "5:agent_message_chunk",
      "unsupported:other_future",
    ]);
    expect(r.state.applied).toBe(7); // no gap: every seq counted
  });

  test("turn and permission tracking; keepRequests = requests the replay leaves pending", () => {
    const r = run(
      [
        { kind: "open_sent" },
        upd(frame(3, { type: "turn_start", turnId: "T", prompt: "p" }, true)),
        upd(req(4, "r1")),
        upd(resolved(5, "r1")),
        upd(req(6, "r2")),
        openResync,
        snap(2),
      ],
      { ...live(9, "old"), phase: "down" },
    );
    expect(r.out[0]).toBe("reset(1, turn=null, keep=r2)");
    expect(r.state.turn).toBe("T");
    expect(r.state.pending).toEqual(["r2"]);
    const ended = run(
      [
        upd(resolved(7, "r2")),
        upd(frame(8, { type: "turn_end", turnId: "T", stopReason: "end_turn" }, true)),
      ],
      r.state,
    );
    expect(ended.state.turn).toBeNull();
    expect(ended.state.pending).toEqual([]);
  });

  test("link_down keeps the position (re-attach with since); a drop mid-resync forgets it", () => {
    expect(sinceOf(run([{ kind: "link_down" }], live(7)).state)).toEqual({ epoch: "e1", seq: 7 });
    const midResync = run([{ kind: "open_sent" }, openResync, { kind: "link_down" }], {
      ...live(7),
      phase: "down",
    });
    expect(sinceOf(midResync.state)).toBeUndefined();
    // A frame for a dead link is dropped.
    expect(run([upd(chunk(8))], run([{ kind: "link_down" }], live(7)).state).out).toEqual([]);
  });

  test("recreated: the turn in flight is lost (never re-run), new seq space", () => {
    const r = run(
      [
        { kind: "open_sent" },
        upd(chunk(1)),
        { kind: "recreated", epoch: "e9", messages: [{ role: "user", content: "a" }], now: 0 },
      ],
      { ...live(40), phase: "down", turn: "T", pending: ["r1"] },
    );
    expect(r.out).toEqual(["turn_lost", "reset(1, turn=null, keep=)", "1:agent_message_chunk"]);
    expect(r.state.pending).toEqual([]);
    expect(sinceOf(r.state)).toEqual({ epoch: "e9", seq: 1 });
  });

  test("session_closed ends the stream for good", () => {
    const r = run(
      [upd(frame(2, { type: "session_closed", reason: "closed" }, true)), upd(chunk(3))],
      live(1),
    );
    expect(r.out).toEqual(["2:session_closed"]);
    expect(r.state.phase).toBe("closed");
  });

  test("the buffer is bounded: past the cap the oldest go, and the hole they leave forces a resync", () => {
    // Review finding 3: a replay (or a hostile pod that never answers `open`)
    // must not grow the laptop's memory without limit.
    const extra = 100;
    let state: StreamState = reduceStream(
      { ...live(3), phase: "down" },
      { kind: "open_sent" },
    ).state;
    for (let seq = 4; seq < 4 + MAX_BUFFERED_UPDATES + extra; seq++) {
      state = reduceStream(state, upd(chunk(seq))).state;
    }
    expect(state.buffer).toHaveLength(MAX_BUFFERED_UPDATES);
    expect(state.buffer[0]?.seq).toBe(4 + extra); // the newest are kept
    // An out-of-order arrival inside the window still lands in seq order, once.
    state = reduceStream(state, upd(chunk(4 + extra + 1))).state;
    expect(state.buffer).toHaveLength(MAX_BUFFERED_UPDATES);
    const r = run([openReplay()], state);
    expect(r.out).toEqual([]); // nothing applied over the hole
    expect(r.effects).toEqual(["reopen"]);
  });
});

// docs/feat/tui-foreign-turns.md B1: each update output carries the turn the
// stream says it belongs to — per output, because one step can drain a buffer
// spanning several turns (the shell stores only the step's final state).
describe("the turn of each update (T-Br)", () => {
  const start = (seq: number, turnId: string) =>
    frame(seq, { type: "turn_start", turnId, prompt: "p" });
  const end = (seq: number, turnId: string) =>
    frame(seq, { type: "turn_end", turnId, stopReason: "end_turn" });
  const turns = (step: StreamStep): (string | null)[] =>
    step.out.flatMap((o) => (o.kind === "update" ? [o.turn] : []));

  test("a drained buffer spanning two turns: X, X, X, Y, Y (never the step's final turn)", () => {
    // Mutation: stamp every output from the step's final state → [Y, Y, Y, Y, Y].
    let state = reduceStream(live(0), { kind: "open_sent" }).state;
    for (const p of [start(1, "X"), chunk(2), end(3, "X"), start(4, "Y"), chunk(5)]) {
      state = reduceStream(state, upd(p)).state;
    }
    const step = reduceStream(state, openReplay());
    expect(turns(step)).toEqual(["X", "X", "X", "Y", "Y"]);
    expect(step.state.turn).toBe("Y");
  });

  test("outside a turn: null; a turn_end that closes no started turn: null", () => {
    const step = reduceStream(live(0), upd(chunk(1)));
    expect(turns(step)).toEqual([null]);
    // An unstarted send-now: its turn_end belongs to no started turn.
    let s = reduceStream(live(0), upd(start(1, "X"))).state;
    const unstarted = reduceStream(s, upd(end(2, "Z")));
    expect(turns(unstarted)).toEqual([null]);
    s = unstarted.state;
    expect(s.turn).toBe("X");
    expect(turns(reduceStream(s, upd(end(3, "X"))))).toEqual(["X"]);
  });

  test("after a reset, updates carry the snapshot's turn", () => {
    const resyncing: StreamState = { ...initialStream, phase: "resyncing", buffer: [chunk(6)] };
    const step = reduceStream(resyncing, {
      kind: "snapshot",
      messages: [],
      since: { epoch: "e1", seq: 5 },
      turn: "R",
      now: 0,
    });
    expect(turns(step)).toEqual(["R"]);
  });
});
