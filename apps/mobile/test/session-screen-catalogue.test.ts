/**
 * The session screen's workflow catalogue (docs/fix/workflows-ux.md D6, defect
 * 4): the hub's Workflows item must not be dimmed as "no workflow runs" over a
 * project that HAS a workflow to start — so the project's catalogue is read ONCE
 * per attach (beside the artifacts read, never on render) and exposed as a raw
 * fact; `catalogueFigure` + `workflowsHub` (pure) are what the hub's item is
 * then folded from. Fake handle, fake clock.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import type { WorkflowCatalogueResult } from "@tentacle/protocol";
import { createSessionController } from "../src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";
import { catalogueFigure, workflowsHub } from "../src/workflow-runs-controller.ts";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
};

const catalogue = (over: Partial<WorkflowCatalogueResult> = {}): WorkflowCatalogueResult => ({
  workflows: [],
  dir: "/p",
  ...over,
});

const oneWorkflow: WorkflowCatalogueResult = catalogue({
  workflows: [
    {
      name: "demo-note",
      path: ".tentacle/workflows/demo-note.yaml",
      ok: true,
      hash: "a".repeat(64),
    },
  ],
});

function harness(
  options: {
    /** What the catalogue read answers: an answer, `{unsupported:true}`, or a throw. */
    readonly answer?: WorkflowCatalogueResult | { unsupported: true } | Error;
    /** Absent: a handle that cannot read a catalogue at all (an old client/fake). */
    readonly withCatalogue?: boolean;
  } = {},
) {
  const calls = { catalogue: 0 };
  /** What the NEXT read answers; a test swaps it to model the project changing. */
  const next: { answer: WorkflowCatalogueResult | { unsupported: true } | Error } = {
    answer: options.answer ?? oneWorkflow,
  };
  const emitted: SessionScreenState[] = [];
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => {},
    async *send() {
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    ...(options.withCatalogue === false
      ? {}
      : {
          workflowCatalogue: () => {
            calls.catalogue += 1;
            const answer = next.answer;
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
          },
        }),
  };
  const screen = () =>
    createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1,
      onChange: (next) => emitted.push(next),
    });
  return {
    screen,
    calls,
    next,
    last: (): SessionScreenState => emitted[emitted.length - 1] as SessionScreenState,
  };
}

describe("the session screen's workflow catalogue", () => {
  test("the attach reads it ONCE, and the state carries the answer", async () => {
    const h = harness();
    const screen = h.screen();
    // Nothing is read on the render path: unknown until the attach.
    expect(screen.state().catalogue).toBeNull();
    expect(h.calls.catalogue).toBe(0);
    await screen.open();
    await settle();
    expect(h.calls.catalogue).toBe(1);
    expect(screen.state().catalogue).toEqual(oneWorkflow);
  });

  test("the hub's item is then NOT dimmed, over a project with one workflow and no run", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    const figure = workflowsHub(
      { kind: "ready", runs: [], offline: null },
      catalogueFigure(screen.state().catalogue),
    );
    expect(figure).toEqual({ needYou: 0, empty: null });
  });

  test("a project with no workflow file is NOT dimmed (the runs screen offers New workflow)", async () => {
    const h = harness({ answer: catalogue() });
    const screen = h.screen();
    await screen.open();
    await settle();
    const figure = workflowsHub(
      { kind: "ready", runs: [], offline: null },
      catalogueFigure(screen.state().catalogue),
    );
    expect(figure).toEqual({ needYou: 0, empty: null });
  });

  test("a FAILED read stays UNKNOWN — never an empty project", async () => {
    const h = harness({ answer: new Error("link down") });
    const screen = h.screen();
    await screen.open();
    await settle();
    expect(screen.state().catalogue).toBeNull();
    expect(
      workflowsHub(
        { kind: "ready", runs: [], offline: null },
        catalogueFigure(screen.state().catalogue),
      ),
    ).toEqual({ needYou: 0, empty: null });
  });

  test("an older daemon ({unsupported:true}) is UNKNOWN too, not empty", async () => {
    const h = harness({ answer: { unsupported: true } });
    const screen = h.screen();
    await screen.open();
    await settle();
    expect(catalogueFigure(screen.state().catalogue)).toEqual({
      known: false,
      count: 0,
      unavailable: null,
    });
  });

  test("a handle that cannot read one makes no call and leaves it UNKNOWN", async () => {
    const h = harness({ withCatalogue: false });
    const screen = h.screen();
    await screen.open();
    await settle();
    expect(h.calls.catalogue).toBe(0);
    expect(screen.state().catalogue).toBeNull();
  });

  // Review round 1 finding 2: the catalogue was read once per attach and nothing
  // re-read it, so a project dimmed "No workflows" kept the item dimmed (and the
  // run list + its Start unreachable from the hub) after a file was added.
  test("a file added after the attach UN-dims the item on the next re-read", async () => {
    const h = harness({ answer: catalogue() });
    const screen = h.screen();
    await screen.open();
    await settle();
    const ready = { kind: "ready", runs: [], offline: null } as const;
    expect(catalogueFigure(screen.state().catalogue)).toMatchObject({ known: true, count: 0 });
    h.next.answer = oneWorkflow;
    await screen.refreshCatalogue();
    await settle();
    expect(h.calls.catalogue).toBe(2);
    expect(screen.state().catalogue).toEqual(oneWorkflow);
    expect(h.last().catalogue).toEqual(oneWorkflow);
    expect(workflowsHub(ready, catalogueFigure(screen.state().catalogue))).toEqual({
      needYou: 0,
      empty: null,
    });
  });

  test("a re-read that FAILS keeps the last answer (unknown never overwrites known)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    h.next.answer = new Error("link down");
    await screen.refreshCatalogue();
    await settle();
    expect(h.calls.catalogue).toBe(2);
    expect(screen.state().catalogue).toEqual(oneWorkflow);
  });

  test("re-reads at the same moment cost ONE call (single-flight)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    await Promise.all([screen.refreshCatalogue(), screen.refreshCatalogue()]);
    await settle();
    expect(h.calls.catalogue).toBe(2);
  });
});
