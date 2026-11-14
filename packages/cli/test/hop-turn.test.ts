/**
 * H5's turn-end machinery (docs/feat/session-hop.md D9): the proposal becomes ONE
 * `session_hop` prompt, the answer decides whether anything is built, and the model
 * is told afterwards. The mutation targets are the plan's own:
 *
 *   - **let `autoApproves` answer `session_hop`** → the row that auto-accept leaves
 *     it PENDING fails (that one lives in `tui/src/permission-ui.ts`'s tests, and is
 *     re-asserted here for the request this module builds);
 *   - the tool's events → one request at turn end, `once` only; No → nothing built.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import type { HopSpec, SessionEvent } from "@tentacle/tui";
import { hopWithLine } from "@tentacle/tui";
import { autoApproves } from "@tentacle/tui";
import { MOVE_DECLINED_LINE } from "../src/hop-proposal.ts";
import {
  NO_HOP_TURN,
  hopAskAtTurnEnd,
  hopPromptRequest,
  hopProposalOutcome,
  hopTurnEnd,
  hopTurnStep,
} from "../src/hop-turn.ts";

const start = (id: string, args: unknown): SessionEvent => ({
  type: "tool_start",
  id,
  name: "move_session",
  arguments: JSON.stringify(args),
});
const done = (id: string, isError = false): SessionEvent => ({
  type: "tool_result",
  id,
  name: "move_session",
  result: { content: "Proposed", isError },
});

/** Fold a whole turn's events, and end it. */
function turn(events: readonly SessionEvent[], own = true) {
  let state = NO_HOP_TURN;
  for (const event of events) {
    state = hopTurnStep(state, event, own);
  }
  return hopTurnEnd(state);
}

/** A spy broker: records every request, answers with `answer`. */
function spyBroker(answer: PermissionResponse | (() => PermissionResponse)) {
  const asked: PermissionRequest[] = [];
  const ask = async (request: PermissionRequest): Promise<PermissionResponse> => {
    asked.push(request);
    return typeof answer === "function" ? answer() : answer;
  };
  return { asked, ask };
}

const FACTS = () => ({ mount: "/home/me/work", workload: "box" });

describe("H5: a proposal becomes ONE session_hop prompt at the turn's end", () => {
  test("a successful move_session → exactly one request, after the turn ended", async () => {
    const watch = turn([start("c1", { target: "container", image: "img:1" }), done("c1")]);
    const broker = spyBroker({ allowed: true, scope: "once" });
    const outcome = await hopAskAtTurnEnd(watch, FACTS, broker.ask);
    expect(broker.asked).toHaveLength(1);
    expect(outcome).toEqual({
      kind: "approved",
      spec: { target: "container", image: "img:1", keep: true },
    });
    const request = broker.asked[0];
    if (request === undefined) {
      throw new Error("no request was asked");
    }
    expect(request.kind).toBe("session_hop");
    expect(request.tool).toBe("move_session");
    expect(request.level).toBe("ask");
    // The detail holds the image and the mount (D9/M6).
    expect(request.detail).toContain("img:1");
    expect(request.detail).toContain("/home/me/work");
  });

  test("a turn with NO proposal asks nothing at all", async () => {
    const watch = turn([{ type: "text", delta: "just an answer" }]);
    const broker = spyBroker({ allowed: true });
    expect(await hopAskAtTurnEnd(watch, FACTS, broker.ask)).toEqual({ kind: "none" });
    expect(broker.asked).toHaveLength(0);
  });

  test("a FAILED call proposes nothing, so nothing is asked", async () => {
    const watch = turn([start("c1", { target: "local" }), done("c1", true)]);
    const broker = spyBroker({ allowed: true });
    expect(await hopAskAtTurnEnd(watch, FACTS, broker.ask)).toEqual({ kind: "none" });
    expect(broker.asked).toHaveLength(0);
  });

  test("a call whose result never arrived is not a proposal (the turn ended mid-call)", async () => {
    const watch = turn([start("c1", { target: "local" })]);
    const broker = spyBroker({ allowed: true });
    expect(await hopAskAtTurnEnd(watch, FACTS, broker.ask)).toEqual({ kind: "none" });
    expect(broker.asked).toHaveLength(0);
  });

  test("a FOREIGN turn's proposal is never asked about here", async () => {
    // Its owner is being asked on their own terminal; asking here would prompt the
    // wrong person, on a session that is not this TUI's to move.
    const watch = turn([start("c1", { target: "local" }), done("c1")], false);
    const broker = spyBroker({ allowed: true });
    expect(await hopAskAtTurnEnd(watch, FACTS, broker.ask)).toEqual({ kind: "none" });
    expect(broker.asked).toHaveLength(0);
  });

  test("the answer must be `allowed`: No, a dismissal, or a reason alone builds NOTHING", () => {
    const spec = { target: "local", keep: true } as const;
    const declined = [
      { allowed: false },
      { allowed: false, dismissed: true as const },
      // A frontend that reports "no human was asked" is a refusal, never a yes.
      { allowed: false, reason: "cannot ask" },
    ];
    for (const response of declined) {
      expect(hopProposalOutcome(spec, response)).toEqual({
        kind: "declined",
        line: MOVE_DECLINED_LINE,
      });
    }
  });

  test("an approval is `once`-only: a session-scoped yes never widens it", () => {
    // The scope is not returned at all — the caller builds from `spec` and there is
    // no standing approval anywhere to widen (D9: nothing is ever remembered).
    const approved = hopProposalOutcome(
      { target: "local", keep: true },
      {
        allowed: true,
        scope: "session",
      },
    );
    expect(approved).toEqual({ kind: "approved", spec: { target: "local", keep: true } });
    // And the request itself offers no suggestion: no rule a scope could remember.
    expect(hopPromptRequest({ target: "local", keep: true }).suggestion).toBeUndefined();
  });

  test("auto-accept can NEVER answer it — even at its own turn, with auto-accept on", () => {
    // The mutation the plan names: let `autoApproves` answer `session_hop` → red.
    const request = hopPromptRequest({ target: "local", keep: true }, FACTS());
    expect(autoApproves(request, true)).toBe(false);
    expect(autoApproves({ ...request, kind: undefined }, true)).toBe(true); // non-vacuity
  });

  test("TWO proposals in one turn still raise ONE prompt — the last one", async () => {
    const watch = turn([
      start("c1", { target: "local" }),
      done("c1"),
      start("c2", { target: "container", image: "img:2" }),
      done("c2"),
    ]);
    const broker = spyBroker({ allowed: true, scope: "once" });
    const outcome = await hopAskAtTurnEnd(watch, FACTS, broker.ask);
    expect(broker.asked).toHaveLength(1);
    expect(outcome).toEqual({
      kind: "approved",
      spec: { target: "container", image: "img:2", keep: true },
    });
  });

  test("a proposal's `reason` reaches the prompt's detail, last and labelled", async () => {
    const watch = turn([start("c1", { target: "local", reason: "needs my machine" }), done("c1")]);
    const broker = spyBroker({ allowed: false });
    await hopAskAtTurnEnd(watch, () => ({}), broker.ask);
    const detail = broker.asked[0]?.detail ?? "";
    expect(detail.split("\n").at(-1)).toContain("needs my machine");
    expect(detail.split("\n").at(-1)).toContain("the model");
  });

  test("a gate shown in the detail and accepted answers it too (ONE prompt, H5 review 2)", async () => {
    // The gate's warning is a paragraph of THIS detail (M6), so a Yes answered the
    // gate as well: the build must not raise a second ask (`gateAnswered`).
    const watch = turn([start("c1", { target: "container", image: "img:1" }), done("c1")]);
    const broker = spyBroker({ allowed: true, scope: "once" });
    const outcome = await hopAskAtTurnEnd(watch, () => ({ gate: "⚠ mount /etc" }), broker.ask);
    expect(broker.asked).toHaveLength(1);
    expect(broker.asked[0]?.detail ?? "").toContain("⚠ mount /etc");
    // Mutation: `hopProposalOutcome` ignoring `shown.gate` → `gateAnswered` gone,
    // and the build asks the owner the same question a second time.
    expect(outcome).toEqual({
      kind: "approved",
      spec: { target: "container", image: "img:1", keep: true },
      gateAnswered: true,
    });
  });

  test("no gate in the detail → no `gateAnswered` (nothing extra was answered)", async () => {
    const watch = turn([start("c1", { target: "container", image: "img:1" }), done("c1")]);
    const broker = spyBroker({ allowed: true, scope: "once" });
    const outcome = await hopAskAtTurnEnd(watch, () => ({}), broker.ask);
    expect(outcome).toEqual({
      kind: "approved",
      spec: { target: "container", image: "img:1", keep: true },
    });
  });

  test("an event AFTER the turn's end changes nothing (a late result is not a proposal)", async () => {
    const ended = turn([start("c1", { target: "local" })]);
    const late = hopTurnStep(ended, done("c1"), true);
    expect(late.proposal).toBeUndefined();
    const broker = spyBroker({ allowed: true });
    expect(await hopAskAtTurnEnd(late, FACTS, broker.ask)).toEqual({ kind: "none" });
  });

  test("an unaskable prompt (the ask throws) is a refusal, not a crash", async () => {
    const watch = turn([start("c1", { target: "local" }), done("c1")]);
    const ask = async (): Promise<PermissionResponse> => {
      throw new Error("the broker is gone");
    };
    // The CALLER turns a throw into a notice; this module's job is that a throw
    // never becomes an approval. `hopAskAtTurnEnd` lets it through, so a caller
    // cannot mistake it for a yes — asserted here so the contract is explicit.
    await expect(hopAskAtTurnEnd(watch, FACTS, ask)).rejects.toThrow("the broker is gone");
  });

  test("the model's next prompt carries the declined line, and only once", () => {
    // The concatenation is the DRIVER's (`hopWithLine`, `useTurnDriver.ts`), so
    // there is one implementation: this pins what the feed hands it.
    const line = MOVE_DECLINED_LINE;
    expect(hopWithLine(line, "hello")).toBe(`${MOVE_DECLINED_LINE}\n\nhello`);
    expect(hopWithLine(line, "hello").split(MOVE_DECLINED_LINE)).toHaveLength(2);
    expect(hopWithLine("", "hello")).toBe("hello");
  });
});
