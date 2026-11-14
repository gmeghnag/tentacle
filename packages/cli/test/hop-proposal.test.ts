import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/tui";
import {
  HOP_PROPOSAL_INVALID,
  NO_HOP_PROPOSAL,
  hopProposalStep,
  hopSpecOf,
  proposalNotice,
} from "../src/hop-proposal.ts";

// docs/feat/session-hop.md slice H1, D9: the `move_session` tool's proposal,
// pure. The arguments are POD-SUPPLIED text on every origin.

const start = (id: string, args: unknown): SessionEvent => ({
  type: "tool_start",
  id,
  name: "move_session",
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const done = (id: string, isError = false): SessionEvent => ({
  type: "tool_result",
  id,
  name: "move_session",
  result: { content: "Proposed; the user will be asked when this turn ends.", isError },
});

/** Every event of a turn folded in, and the one proposal it made (if any). */
function fold(events: readonly SessionEvent[], own = true) {
  let watch = NO_HOP_PROPOSAL;
  const steps: ReturnType<typeof hopProposalStep>["step"][] = [];
  for (const event of events) {
    const out = hopProposalStep(watch, event, own);
    watch = out.watch;
    steps.push(out.step);
  }
  return { watch, steps };
}

describe("hopSpecOf: the proposal schema", () => {
  test("the four targets become the `/move` specs, keep defaulting to true (decision 5)", () => {
    expect(hopSpecOf(JSON.stringify({ target: "local" }))?.spec).toEqual({
      target: "local",
      keep: true,
    });
    expect(hopSpecOf(JSON.stringify({ target: "local", keep: false }))?.spec).toEqual({
      target: "local",
      keep: false,
    });
    expect(hopSpecOf(JSON.stringify({ target: "container", image: "img:1" }))?.spec).toEqual({
      target: "container",
      image: "img:1",
      keep: true,
    });
    expect(hopSpecOf(JSON.stringify({ target: "container" }))?.spec).toEqual({
      target: "container",
      keep: true,
    });
    expect(
      hopSpecOf(
        JSON.stringify({
          target: "attach",
          workload: { engine: "kubernetes", name: "web-0", container: "app" },
        }),
      )?.spec,
    ).toEqual({
      target: "attach",
      workload: { engine: "kubernetes", name: "web-0", container: "app" },
      keep: true,
    });
    expect(hopSpecOf(JSON.stringify({ target: "local", reason: "big build" }))?.reason).toBe(
      "big build",
    );
  });

  test("an argument a newer daemon added is ignored, not fatal (forward compatibility)", () => {
    expect(hopSpecOf(JSON.stringify({ target: "local", gpu: true }))?.spec).toEqual({
      target: "local",
      keep: true,
    });
  });

  test("not JSON, not a move, and a cross-field contradiction are all null", () => {
    for (const args of [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({ target: "sideways" }),
      JSON.stringify({ target: "attach" }),
      JSON.stringify({ target: "attach", workload: { engine: "aws", name: "x" } }),
      JSON.stringify({ target: "attach", workload: { engine: "docker", name: "" } }),
      // A workload with a target that takes none, and an image where none is used.
      JSON.stringify({ target: "local", workload: { engine: "docker", name: "box" } }),
      JSON.stringify({ target: "local", image: "img" }),
      JSON.stringify({ target: "container", keep: "yes" }),
    ]) {
      expect(hopSpecOf(args)).toBeNull();
    }
  });

  test("a proposed workload obeys the SAME grammar as a typed /move attach", () => {
    // Finding 2 of the H1 review: the tool path and `/move` accepted different
    // things. One validator now, so these are refused here as they are there.
    // Mutation: drop the `hopWorkload` call → the first four become specs.
    for (const workload of [
      { engine: "docker", name: "box", container: "x" },
      { engine: "podman", name: "box", container: "x" },
      { engine: "docker", name: "bo:x" },
      { engine: "kubernetes", name: "web-0", container: "app/1" },
      { engine: "docker", name: "b\u001bx" },
      { engine: "kubernetes", name: "we b" },
      { engine: "kubernetes", name: "web-0", container: "" },
      { engine: "docker", name: "a".repeat(254) },
    ]) {
      expect(hopSpecOf(JSON.stringify({ target: "attach", workload }))).toBeNull();
    }
    // And the same input a typed `/move attach` takes is taken here, unchanged.
    expect(
      hopSpecOf(
        JSON.stringify({
          target: "attach",
          workload: { engine: "kubernetes", name: "web-0", container: "guard" },
        }),
      )?.spec,
    ).toEqual({
      target: "attach",
      workload: { engine: "kubernetes", name: "web-0", container: "guard" },
      keep: true,
    });
  });
});

describe("hopProposalStep: watching a turn", () => {
  test("a successful move_session proposes a hop, once, at its result", () => {
    const { steps } = fold([start("c1", { target: "container", image: "img:1" }), done("c1")]);
    expect(steps[0]).toEqual({ kind: "none" });
    expect(steps[1]).toEqual({
      kind: "proposed",
      spec: { target: "container", image: "img:1", keep: true },
    });
  });

  test("a failed or refused call proposes nothing (its own text says why)", () => {
    // Mutation: drop the `isError` guard → this fails, and a denial is re-asked.
    expect(fold([start("c1", { target: "local" }), done("c1", true)]).steps[1]).toEqual({
      kind: "none",
    });
  });

  test("a successful call with unreadable arguments is said, never swallowed", () => {
    const { steps } = fold([start("c1", "{oops"), done("c1")]);
    expect(steps[1]).toEqual({ kind: "invalid" });
    expect(HOP_PROPOSAL_INVALID).toContain("nothing moved");
  });

  test("another tool's call is not a proposal", () => {
    const { steps } = fold([
      { type: "tool_start", id: "s1", name: "shell", arguments: "{}" },
      { type: "tool_result", id: "s1", name: "shell", result: { content: "ok" } },
    ]);
    expect(steps).toEqual([{ kind: "none" }, { kind: "none" }]);
  });

  test("a FOREIGN turn never proposes here (the owner is asked on their own terminal)", () => {
    // Mutation: ignore `own` → a pod-driven turn moves this session.
    const { steps, watch } = fold([start("c1", { target: "local" }), done("c1")], false);
    expect(steps).toEqual([{ kind: "none" }, { kind: "none" }]);
    expect(watch).toEqual(NO_HOP_PROPOSAL);
  });

  test("two calls in one turn propose twice, in order; the watch ends empty", () => {
    const { steps, watch } = fold([
      start("c1", { target: "container" }),
      done("c1"),
      start("c2", { target: "local" }),
      done("c2"),
    ]);
    expect(steps.filter((s) => s.kind === "proposed")).toHaveLength(2);
    expect(watch).toEqual(NO_HOP_PROPOSAL);
  });

  test("a result with no matching start (a resumed transcript) is ignored", () => {
    expect(fold([done("ghost")]).steps[0]).toEqual({ kind: "none" });
  });
});

describe("proposalNotice: what the owner reads before approving", () => {
  test("it names the target and the reason, and says nothing was done yet", () => {
    expect(proposalNotice({ target: "local", keep: true }, "the build is done")).toBe(
      "_the model proposes moving this session to local — the build is done_",
    );
    expect(proposalNotice({ target: "container", keep: true })).toBe(
      "_the model proposes moving this session to a container (the default image)_",
    );
    expect(
      proposalNotice({ target: "attach", workload: { engine: "docker", name: "box" }, keep: true }),
    ).toBe("_the model proposes moving this session to docker:box_");
  });

  test("the image is NAMED, never hidden: it decides what runs with our folder mounted", () => {
    // Finding 1 of the H1 review (HIGH): the prompt said only "a container", so
    // the owner approved an image they never saw. D6 binds the cwd into it.
    // Mutation: drop the `spec.image` term → both rows below show "a container".
    expect(proposalNotice({ target: "container", image: "attacker.io/x:latest", keep: true })).toBe(
      "_the model proposes moving this session to a container running attacker.io/x:latest_",
    );
    expect(
      proposalNotice({ target: "container", image: "ghcr.io/ok/img:1", keep: true }, "faster"),
    ).toBe(
      "_the model proposes moving this session to a container running ghcr.io/ok/img:1 — faster_",
    );
  });

  test("a pod-supplied image is sanitized too (AGENTS §7)", () => {
    // Mutation: interpolate `spec.image` raw → the escape and the newline survive.
    const text = proposalNotice({
      target: "container",
      image: "x\u001b[31mevil\nline",
      keep: true,
    });
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\n");
  });

  test("a delete is said out loud, never hidden in a flag", () => {
    // Mutation: drop the `remove` term → the owner approves a delete unknowingly.
    expect(proposalNotice({ target: "local", keep: false })).toContain("remove the workload");
  });

  test("a pod-supplied name and reason are sanitized (AGENTS §7)", () => {
    const nasty = "esc\u001b[31m\nnewline";
    const text = proposalNotice(
      { target: "attach", workload: { engine: "docker", name: nasty }, keep: true },
      nasty,
    );
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\n");
  });
});
