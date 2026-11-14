/**
 * Parity (13a, plan "Tests"): the app's own queue module must decide exactly
 * what the TUI's `packages/tui/src/queued.ts` and the client's
 * `packages/client/src/hand-back.ts` decide, on the same fixtures.
 *
 * Why mirrored at all: the app cannot import those (the TUI drags
 * `@tentacle/agent` into the bundle, and `hand-back.ts` is not exported from
 * `@tentacle/client` — plan P3). Why mirrored SAFELY: this file. If the app's
 * copy drifts from the rule the laptop already implements, the pin fails.
 *
 * The imports are TEST-ONLY and relative (the 12b `transcript-parity` pattern).
 */
import { describe, expect, test } from "bun:test";
import type { QueueState, ReturnCause } from "@tentacle/protocol";
import { handBack } from "../../../packages/client/src/hand-back.ts";
import {
  type QueuedRows,
  afterRefusal as tuiAfterRefusal,
  returnedNotice as tuiReturnedNotice,
  shownRows as tuiShownRows,
  takeForSendNow as tuiTake,
} from "../../../packages/tui/src/queued.ts";
import {
  type OwnIds,
  afterRefusal,
  planHandBack,
  returnedNotice,
  shownRows,
  takeForSendNow,
} from "../src/compose-queue.ts";

const rows = (spec: readonly (readonly [string, string])[]): QueuedRows =>
  spec.map(([id, text]) => ({ id, text, state: "queued" as const }));

const own = (pairs: readonly (readonly [string, string])[]): OwnIds => new Map(pairs);

/** My rows only: the app's view carries `mine`, the TUI's does not. */
const shape = (list: readonly { id: string; text: string; state: string }[]) =>
  list.map((r) => [r.id, r.text, r.state]);

describe("shown rows parse the same", () => {
  const local = rows([
    ["q1", "acked"],
    ["q2", "in flight"],
  ]);
  const acked = new Set(["q1"]);

  test.each([
    ["no report", undefined],
    ["empty report", { entries: [] }],
    [
      "the daemon lists mine and another's",
      {
        entries: [
          { id: "theirs", text: "from the laptop" },
          { id: "q1", text: "acked" },
          { id: "q2", text: "in flight" },
        ],
      },
    ],
    ["mine drained", { entries: [{ id: "theirs", text: "from the laptop" }] }],
  ] as const)("%s", (_name, daemon) => {
    const tuiRows = local.map((r) => (acked.has(r.id) ? { ...r, acked: true as const } : r));
    expect(shape(shownRows(tuiRows, daemon, own([["q1", "acked"]])))).toEqual(
      shape(tuiShownRows(tuiRows, daemon)),
    );
  });

  test("state survives a send-now take, both sides", () => {
    const mine = rows([["q1", "one"]]);
    expect(shape(takeForSendNow(mine).rows)).toEqual(shape(tuiTake(mine).rows));
    expect(takeForSendNow(mine).messages).toEqual(tuiTake(mine).messages);
  });
});

describe("send-now refusals agree", () => {
  test.each([
    ["no report, old turn running", null, true],
    ["no report, old turn over", null, false],
    ["the daemon holds one", new Set(["q1"]), true],
    ["the daemon holds everything", new Set(["q1", "q2"]), false],
  ] as const)("%s", (_name, held, oldRunning) => {
    const sending: QueuedRows = [
      { id: "q1", text: "one", state: "sending" },
      { id: "q2", text: "two", state: "sending" },
      { id: "late", text: "typed after", state: "queued" },
    ];
    const app = afterRefusal(sending, held, oldRunning);
    const tui = tuiAfterRefusal(sending, held, oldRunning);
    expect(shape(app.rows)).toEqual(shape(tui.rows));
    expect(app.text).toBe(tui.text);
  });
});

describe("hand-back agrees with the client", () => {
  const fixtures: readonly {
    readonly name: string;
    readonly state: QueueState;
    readonly mine: readonly (readonly [string, string])[];
    readonly handedBack: readonly string[];
    readonly carried: readonly string[];
  }[] = [
    {
      name: "nothing returned",
      state: { entries: [], returned: [] },
      mine: [["q1", "mine"]],
      handedBack: [],
      carried: [],
    },
    {
      name: "mine, fresh",
      state: { entries: [], returned: [{ id: "q1", text: "x", cause: "cancelled" }] },
      mine: [["q1", "mine"]],
      handedBack: [],
      carried: [],
    },
    {
      name: "mine, already given back",
      state: { entries: [], returned: [{ id: "q1", text: "x", cause: "cancelled" }] },
      mine: [["q1", "mine"]],
      handedBack: ["q1"],
      carried: [],
    },
    {
      name: "mine, carried by a live send-now",
      state: { entries: [], returned: [{ id: "q1", text: "x", cause: "failed" }] },
      mine: [["q1", "mine"]],
      handedBack: [],
      carried: ["q1"],
    },
    {
      name: "another writer's row only",
      state: { entries: [], returned: [{ id: "theirs", text: "x", cause: "ended" }] },
      mine: [["q1", "mine"]],
      handedBack: [],
      carried: [],
    },
    {
      name: "the same id twice",
      state: {
        entries: [],
        returned: [
          { id: "q1", text: "a", cause: "cancelled" },
          { id: "q1", text: "b", cause: "cancelled" },
        ],
      },
      mine: [["q1", "mine"]],
      handedBack: [],
      carried: [],
    },
    {
      name: "a mix",
      state: {
        entries: [{ id: "q2", text: "waiting" }],
        returned: [
          { id: "theirs", text: "x", cause: "cancelled" },
          { id: "q1", text: "y", cause: "failed" },
          { id: "q2", text: "z", cause: "failed" },
        ],
      },
      mine: [
        ["q1", "one"],
        ["q2", "two"],
      ],
      handedBack: [],
      carried: [],
    },
  ];

  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const mine = own(fixture.mine);
      const handedBack = new Set(fixture.handedBack);
      const carried = new Set(fixture.carried);
      const client = handBack(fixture.state, mine, handedBack, carried);
      const app = planHandBack(fixture.state, mine, handedBack, carried);
      expect(app.give).toEqual(client.give);
      expect(app.reclaim).toEqual(client.reclaim);
    });
  }
});

describe("banners agree", () => {
  test.each([
    ...([1, 2, 3] as const).flatMap((n) =>
      (["cancelled", "failed", "ended"] as const).flatMap((cause: ReturnCause) =>
        [true, false].map((stoppedHere) => [n, cause, stoppedHere] as const),
      ),
    ),
  ])("%i row(s), %s, stoppedHere=%s", (n, cause, stoppedHere) => {
    expect(returnedNotice(n, cause, stoppedHere)).toBe(tuiReturnedNotice(n, cause, stoppedHere));
  });
});
