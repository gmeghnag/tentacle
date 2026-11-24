/**
 * `workflow-edit-controller.ts` (docs/feat/workflow-editor.md D7, slice 6): the
 * state machine the editor screen draws.
 *
 * The two properties this file exists to pin, in the plan's own words:
 * - a `changed` refusal KEEPS the draft (never a silent overwrite), and
 * - a save whose answer was lost is decided on reconnect by the file's HASH
 *   alone: preview → saved, base → still dirty, other → changed.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowSaveRequest } from "@tentacle/client";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowDraft,
  asDraft,
  deleteStep,
  workflowYaml,
} from "@tentacle/core";
import type { WorkflowSaveResult, WorkflowSourceResult } from "@tentacle/protocol";
import {
  EDIT_CHANGED,
  EDIT_FIX_ELSEWHERE,
  EDIT_NOTHING_TO_SAVE,
  EDIT_OFFLINE,
  EDIT_SAVE_PENDING,
  EDIT_UPDATE_TENTACLE,
  type EditSessionHandle,
  type EditState,
  createWorkflowEditController,
  discardText,
  existsNotice,
  reconnectOutcome,
  saveOffReason,
  savedToast,
} from "../src/workflow-edit-controller.ts";

const BASE = "b".repeat(64);
const PREVIEWED = "c".repeat(64);

/** The template's own draft, as the daemon hands it over (JSON text). */
const loop = WORKFLOW_TEMPLATES.find((t) => t.id === "plan-build-review-merge");
if (loop === undefined) {
  throw new Error("the plan-build-review-merge template must exist");
}
const TEMPLATE = loop;

/** A loaded file: the template's draft, version 2, as `session/workflow_source` reports it. */
function source(over: Partial<WorkflowSourceResult> = {}): WorkflowSourceResult {
  const draft = TEMPLATE.draft("demo", "a demo", { slug: { required: true } });
  return {
    ok: true,
    path: ".tentacle/workflows/demo.yaml",
    text: workflowYaml(draft),
    draft: JSON.stringify({ ...draft, version: 2 }),
    prompts: Object.entries(TEMPLATE.prompts).map(([path, text]) => ({ path, text })),
    hash: BASE,
    version: 2,
    canonical: true,
    context: { models: ["opus", "sonnet"], agentTypes: ["general"] },
    ...over,
  };
}

const okSave = (over: Partial<WorkflowSaveResult> = {}): WorkflowSaveResult => ({
  ok: true,
  hash: PREVIEWED,
  version: 3,
  path: ".tentacle/workflows/demo.yaml",
  files: [{ path: ".tentacle/workflows/demo.yaml", status: "changed", added: 2, removed: 1 }],
  approved: false,
  ...over,
});

function harness(
  opts: {
    open?: "ok" | "archived" | "gone" | "link";
    borrowed?: boolean;
    name?: string | null;
    /** Each source read answers with the next of these (the last one repeats). */
    reads?: readonly (WorkflowSourceResult | { unsupported: true } | Error)[];
    /** Each save answers with the next of these (the last one repeats). */
    saves?: readonly (WorkflowSaveResult | { unsupported: true } | Error)[];
    /**
     * The CONFIRM (`dryRun:false`) dies with this error: the answer never
     * arrived because the link dropped mid-write. The preview still answers.
     */
    confirmFails?: string;
  } = {},
) {
  const reads = [...(opts.reads ?? [source()])];
  const saves = [...(opts.saves ?? [okSave()])];
  const sent: WorkflowSaveRequest[] = [];
  const readNames: string[] = [];
  const openCalls: unknown[][] = [];
  let leaves = 0;
  let changes = 0;
  const session: EditSessionHandle = {
    async workflowSource(name: string) {
      readNames.push(name);
      const next = reads.length > 1 ? reads.shift() : reads[0];
      if (next instanceof Error) {
        throw next;
      }
      return next ?? source();
    },
    workflowSave(request: WorkflowSaveRequest) {
      sent.push(request);
      if (opts.confirmFails !== undefined && request.dryRun === false) {
        return Promise.reject(new Error(opts.confirmFails));
      }
      const next = saves.length > 1 ? saves.shift() : saves[0];
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next ?? okSave());
    },
  };
  const controller = createWorkflowEditController({
    sessionId: "s1",
    open: async (...args: unknown[]) => {
      openCalls.push(args);
      const o = opts.open ?? "ok";
      return o === "ok" ? { ok: true as const, session } : { ok: false as const, reason: o };
    },
    leave: () => {
      leaves += 1;
    },
    borrowed: opts.borrowed ?? false,
    ...(opts.name === null ? {} : { name: opts.name ?? "demo" }),
    onChange: () => {
      changes += 1;
    },
  });
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return {
    controller,
    flush,
    sent,
    readNames,
    openCalls,
    get leaves() {
      return leaves;
    },
    get changes() {
      return changes;
    },
    state: (): EditState => controller.state(),
  };
}

/** Attach and land the file: everything a tap on a catalogue row's Edit does. */
async function opened(h: ReturnType<typeof harness>): Promise<EditState> {
  h.controller.start();
  await h.flush();
  return h.state();
}

/** One real edit (a retry bump on the first step), so the draft is dirty. */
function touched(h: ReturnType<typeof harness>): void {
  h.controller.setRetry("exec", 2);
}

/** Review and confirm: the two-step save D7 describes. */
async function saved(h: ReturnType<typeof harness>): Promise<void> {
  touched(h);
  h.controller.beginReview();
  await h.flush();
  h.controller.confirmSave();
  await h.flush();
}

describe("the attach", () => {
  test("opens the session WITHOUT reopen, then reads the file by name", async () => {
    const h = harness();
    await opened(h);
    expect(h.openCalls).toEqual([["s1"]]);
    expect(h.readNames).toEqual(["demo"]);
    expect(h.state().kind).toBe("editing");
  });

  test("an ended session says so and offers no editor", async () => {
    const h = harness({ open: "archived" });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("ended");
    expect(h.state().draft).toBeNull();
  });

  test("a failed attach is `failed`, with the link's reason", async () => {
    const h = harness({ open: "link" });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("failed");
    expect(h.state().reason).toContain("link");
  });

  test("leaves only when this screen opened the session", async () => {
    const mine = harness();
    mine.controller.start();
    await mine.flush();
    mine.controller.dispose();
    expect(mine.leaves).toBe(1);

    const borrowed = harness({ borrowed: true });
    borrowed.controller.start();
    await borrowed.flush();
    borrowed.controller.dispose();
    expect(borrowed.leaves).toBe(0);
  });
});

describe("the three screens that have no editor", () => {
  test("`unreadable` shows the daemon's reason plus the advice, verbatim", async () => {
    const h = harness({
      reads: [source({ draft: undefined, unreadable: "steps: is not an array" })],
    });
    await opened(h);
    expect(h.state().kind).toBe("unreadable");
    expect(h.state().reason).toBe("steps: is not an array");
    expect(EDIT_FIX_ELSEWHERE).toBe("Fix it on the computer or ask the model");
  });

  test("`unsupported` is an older daemon's own screen", async () => {
    const h = harness({ reads: [{ unsupported: true }] });
    await opened(h);
    expect(h.state().kind).toBe("unsupported");
    expect(EDIT_UPDATE_TENTACLE).toBe("Update tentacle on this computer");
  });

  test("`unavailable` is a pod's session — NOT 'the file is missing'", async () => {
    const h = harness({
      reads: [source({ ok: false, draft: undefined, unavailable: "not here" })],
    });
    await opened(h);
    expect(h.state().kind).toBe("unavailable");
    expect(h.state().reason).toBe("not here");
  });

  test("an invalid file is `broken`: a `replace` save could never repair it", async () => {
    // The writer's base check needs the file on disk to HASH to `baseHash`, and
    // an invalid file has no hash at all, so a replace save answers `changed`
    // forever (probe: .tentacle/tmp/workflow-editor/s6/broken-base.ts). The
    // editor says so instead of offering an edit that cannot be saved.
    const h = harness({
      reads: [source({ hash: undefined, errors: ["steps[0].run: should not be empty"] })],
    });
    await opened(h);
    expect(h.state().kind).toBe("broken");
    expect(h.state().errors).toEqual(["steps[0].run: should not be empty"]);
    expect(h.state().reason).toBe("steps[0].run: should not be empty");
  });
});

describe("Save is off, and the reason is always a string", () => {
  test("offline: the draft stays on this phone", async () => {
    const h = harness();
    await opened(h);
    h.controller.setLink(false);
    expect(h.state().saveOff).toBe(EDIT_OFFLINE);
    expect(h.controller.canSave()).toBe(false);
  });

  test("invalid: the FIRST problem, word for word, with its YAML path", async () => {
    const h = harness();
    await opened(h);
    // Emptying a run step's command is a real problem the validator names.
    h.controller.patch("gate", { kind: "run", run: "" });
    const first = h.state().problems[0] ?? "";
    expect(first).toBe("steps[4].run: should not be empty");
    expect(h.state().saveOff).toBe(first);
    expect(h.controller.canSave()).toBe(false);
  });

  test("clean: nothing changed yet", async () => {
    const h = harness();
    await opened(h);
    expect(h.state().dirty).toBe(false);
    expect(h.state().saveOff).toBe(EDIT_NOTHING_TO_SAVE);
    expect(h.controller.canSave()).toBe(false);
  });

  test("an edit makes it savable, and the gate follows the three inputs", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    expect(h.controller.canSave()).toBe(true);
    h.controller.setLink(false);
    expect(h.controller.canSave()).toBe(false);
    h.controller.setLink(true);
    expect(h.controller.canSave()).toBe(true);
  });

  test("`saveOffReason` puts the link first, then the problem, then dirtiness", () => {
    expect(saveOffReason({ offline: true, problems: ["bad"], dirty: true })).toBe(EDIT_OFFLINE);
    expect(saveOffReason({ offline: false, problems: ["bad"], dirty: true })).toBe("bad");
    expect(saveOffReason({ offline: false, problems: [], dirty: true })).toBeNull();
    expect(saveOffReason({ offline: false, problems: [], dirty: false })).toBe(
      EDIT_NOTHING_TO_SAVE,
    );
  });
});

describe("review then confirm", () => {
  test("Save sends dryRun:true and writes nothing; Review is its answer", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.dryRun).toBe(true);
    expect(h.state().kind).toBe("reviewing");
    expect(h.state().preview?.hash).toBe(PREVIEWED);
    expect(h.state().preview?.files?.length).toBe(1);
  });

  test("confirm sends dryRun:false with the BASE hash, and lands `saved`", async () => {
    const h = harness({
      saves: [okSave({ hash: PREVIEWED }), okSave({ hash: PREVIEWED })],
    });
    await opened(h);
    await saved(h);
    expect(h.sent.length).toBe(2);
    expect(h.sent[0]?.dryRun).toBe(true);
    expect(h.sent[1]?.dryRun).toBe(false);
    expect(h.sent[1]?.baseHash).toBe(BASE);
    expect(h.sent[1]?.mode).toBe("replace");
    expect(h.sent[1]?.name).toBe("demo");
    const state = h.state();
    expect(state.kind).toBe("saved");
    expect(state.saved?.hash).toBe(PREVIEWED);
    expect(state.saved?.version).toBe(3);
    expect(h.controller.canRun()).toBe(true);
  });

  test("the preview's hash IS what confirm writes (one emitter, deterministic)", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    const previewHash = h.state().preview?.hash;
    h.controller.confirmSave();
    await h.flush();
    expect(h.sent[1]?.draft).toBe(h.sent[0]?.draft ?? "");
    expect(previewHash ?? "").toBe(h.state().saved?.hash ?? "");
  });

  test("the request carries only the prompt files the steps read", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    const carried = (h.sent[0]?.prompts ?? []).map((p) => p.path).sort();
    expect(carried).toEqual(Object.keys(TEMPLATE.prompts).sort());
  });

  test("a prompt file NO step reads is not carried (the daemon would refuse it)", async () => {
    // The template references every file it ships, so the rule needs a draft
    // where the two differ: `exec` switched to an inline prompt drops its file.
    // Carrying it anyway is the daemon's `invalid` ("not used by any step").
    const h = harness();
    await opened(h);
    h.controller.prompt("exec", { text: "inline instead" });
    h.controller.beginReview();
    await h.flush();
    const carried = (h.sent[0]?.prompts ?? []).map((p) => p.path).sort();
    expect(carried).not.toContain("prompts/exec.md");
    expect(carried).toContain("prompts/plan.md");
  });

  test("Cancel on Review sends nothing more and keeps the draft", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    const before = h.state().draft;
    h.controller.cancelReview();
    expect(h.state().kind).toBe("editing");
    expect(h.state().draft).toEqual(before);
    expect(h.sent.length).toBe(1);
  });

  test("a preview refusal lands on the bar, not in Review", async () => {
    const h = harness({
      saves: [
        { ok: false, refusal: "invalid", reason: "steps[0].id: bad", errors: ["steps[0].id: bad"] },
      ],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    expect(h.state().kind).toBe("editing");
    expect(h.state().preview).toBeNull();
    expect(h.state().errors).toEqual(["steps[0].id: bad"]);
  });
});

describe("the outcomes, by refusal word", () => {
  test("`changed` KEEPS the draft and offers Reload / Keep editing", async () => {
    const h = harness({
      saves: [okSave(), { ok: false, refusal: "changed", reason: "changed on the computer" }],
    });
    await opened(h);
    await saved(h);
    const state = h.state();
    expect(state.kind).toBe("editing");
    expect(state.changed).toBe(true);
    // The mutation target: a reset draft here would lose the user's work.
    expect(state.draft).not.toBeNull();
    expect(JSON.stringify(state.draft)).toContain('"retry":2');
    expect(state.saved).toBeNull();
    expect(EDIT_CHANGED).toBe("Changed on the computer");
  });

  test("Keep editing drops the banner and keeps the draft", async () => {
    const h = harness({
      saves: [okSave(), { ok: false, refusal: "changed" }],
    });
    await opened(h);
    await saved(h);
    h.controller.keepEditing();
    expect(h.state().changed).toBe(false);
    expect(JSON.stringify(h.state().draft)).toContain('"retry":2');
  });

  test("Reload discards the draft and reads the file again", async () => {
    const h = harness({
      reads: [source(), source({ hash: "d".repeat(64) })],
      saves: [okSave(), { ok: false, refusal: "changed" }],
    });
    await opened(h);
    await saved(h);
    h.controller.reload();
    await h.flush();
    expect(h.readNames).toEqual(["demo", "demo"]);
    expect(h.state().kind).toBe("editing");
    expect(h.state().changed).toBe(false);
    expect(JSON.stringify(h.state().draft)).not.toContain('"retry":2');
  });

  test("`exists` names the file, and a rename on a CREATE is the repair", async () => {
    const h = harness({
      name: null,
      saves: [okSave(), { ok: false, refusal: "exists", reason: "already exists" }],
    });
    h.controller.create("plan-build-review-merge", "demo", "", { slug: { required: true } });
    h.controller.start();
    await h.flush();
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    expect(h.state().notice).toBe(existsNotice("demo"));
    expect(existsNotice("demo")).toBe("A workflow (or prompt file) named demo exists");
    h.controller.renameFile("demo-2");
    expect(h.state().name).toBe("demo-2");
    expect(h.state().notice).toBeNull();
  });

  test("a rename is refused in `replace` mode (an existing file is not renamed in place)", async () => {
    const h = harness();
    await opened(h);
    h.controller.renameFile("demo-2");
    expect(h.state().name).toBe("demo");
  });

  test("a rename refuses a name the wire would refuse", async () => {
    const h = harness({ name: null });
    h.controller.create("blank", "demo");
    h.controller.start();
    await h.flush();
    h.controller.renameFile("Not A Name");
    expect(h.state().name).toBe("demo");
    expect(h.state().notice).toContain("lowercase");
  });

  test("`unavailable` mid-save is its own screen", async () => {
    const h = harness({
      saves: [okSave(), { ok: false, refusal: "unavailable", reason: "not editable here" }],
    });
    await opened(h);
    await saved(h);
    expect(h.state().kind).toBe("unavailable");
    expect(h.state().reason).toBe("not editable here");
  });

  test("`unsupported` mid-save hides the editor", async () => {
    const h = harness({ saves: [okSave(), { unsupported: true }] });
    await opened(h);
    await saved(h);
    expect(h.state().kind).toBe("unsupported");
  });
});

describe("a save whose answer was lost: the hash decides on reconnect", () => {
  test("the preview's hash on disk → saved (it landed)", async () => {
    const h = harness({
      confirmFails: "the link dropped",
      reads: [source(), source({ hash: PREVIEWED, version: 3 })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    // The link drops mid-save; the answer never arrives.
    h.controller.setLink(false);
    await h.flush();
    expect(h.state().kind).toBe("editing");
    // Nothing is read while the link is down.
    expect(h.readNames).toEqual(["demo"]);
    h.controller.setLink(true);
    await h.flush();
    expect(h.state().kind).toBe("saved");
    expect(h.state().saved?.hash).toBe(PREVIEWED);
  });

  test("still the base hash → editing, and the draft is STILL dirty", async () => {
    const h = harness({
      confirmFails: "the link dropped",
      reads: [source(), source({ hash: BASE })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    h.controller.setLink(false);
    h.controller.setLink(true);
    await h.flush();
    expect(h.state().kind).toBe("editing");
    expect(h.state().dirty).toBe(true);
    expect(JSON.stringify(h.state().draft)).toContain('"retry":2');
  });

  test("a third hash → the `changed` path", async () => {
    const h = harness({
      confirmFails: "the link dropped",
      reads: [source(), source({ hash: "e".repeat(64) })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    h.controller.setLink(false);
    h.controller.setLink(true);
    await h.flush();
    expect(h.state().kind).toBe("editing");
    expect(h.state().changed).toBe(true);
  });

  test("nothing is re-sent: the reconnect only READS", async () => {
    const h = harness({
      confirmFails: "the link dropped",
      reads: [source(), source({ hash: PREVIEWED })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    const sentBefore = h.sent.length;
    h.controller.setLink(false);
    h.controller.setLink(true);
    await h.flush();
    expect(h.sent.length).toBe(sentBefore);
  });

  test("edits made AFTER the lost save stay dirty when it landed (never marked saved)", async () => {
    const h = harness({
      confirmFails: "the link dropped",
      reads: [source(), source({ hash: PREVIEWED, version: 3 })],
    });
    await opened(h);
    touched(h); // retry 2 — this is what the lost write carried
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    h.controller.setLink(false);
    await h.flush();
    // Offline editing continues: a later edit the disk never saw.
    h.controller.setRetry("exec", 3);
    expect(h.state().dirty).toBe(true);
    h.controller.setLink(true);
    await h.flush();
    // The write landed (its hash is on disk), but `retry: 3` is NOT on disk.
    expect(h.state().kind).toBe("editing");
    expect(h.state().dirty).toBe(true);
    expect(JSON.stringify(h.state().draft)).toContain('"retry":3');
    expect(h.controller.discardPrompt()).not.toBeNull();
    // The baseline is what LANDED: discarding goes back to `retry: 2`.
    h.controller.discard();
    expect(JSON.stringify(h.state().draft)).toContain('"retry":2');
    expect(h.state().dirty).toBe(false);
    // And the next save replaces the landed bytes.
    h.controller.setRetry("exec", 4);
    h.controller.beginReview();
    await h.flush();
    expect(h.sent.at(-1)?.baseHash).toBe(PREVIEWED);
  });

  test("a lost save with the link still up is checked AT ONCE (no down→up needed)", async () => {
    const h = harness({
      confirmFails: "rpc error",
      reads: [source(), source({ hash: PREVIEWED, version: 3 })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    expect(h.readNames).toEqual(["demo", "demo"]);
    expect(h.state().kind).toBe("saved");
    expect(h.state().saved?.hash).toBe(PREVIEWED);
  });

  test("Save is OFF while a lost save is undecided; a later link-up re-checks", async () => {
    const h = harness({
      confirmFails: "rpc error",
      reads: [source(), new Error("still flaky"), source({ hash: PREVIEWED, version: 3 })],
    });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    h.controller.confirmSave();
    await h.flush();
    // The immediate check failed: the decision is still pending.
    h.controller.setRetry("exec", 3);
    expect(h.state().kind).toBe("editing");
    expect(h.state().saveOff).toContain("last save");
    expect(h.controller.canSave()).toBe(false);
    const sentBefore = h.sent.length;
    h.controller.beginReview();
    await h.flush();
    expect(h.sent.length).toBe(sentBefore);
    // The link is reported up again (never seen down): the hash decides now.
    h.controller.setLink(true);
    await h.flush();
    expect(h.state().saved?.hash).toBe(PREVIEWED);
    expect(h.state().dirty).toBe(true);
    expect(h.controller.canSave()).toBe(true);
  });

  test("`saveOffReason`: a pending lost save turns Save off (after offline)", () => {
    expect(saveOffReason({ offline: false, problems: [], dirty: true, pending: true })).toBe(
      EDIT_SAVE_PENDING,
    );
    expect(saveOffReason({ offline: true, problems: [], dirty: true, pending: true })).toBe(
      EDIT_OFFLINE,
    );
  });

  test("a lost PREVIEW wrote nothing: no check, Save stays on", async () => {
    const h = harness({ saves: [new Error("rpc error")] });
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    expect(h.state().kind).toBe("editing");
    expect(h.controller.canSave()).toBe(true);
    expect(h.readNames).toEqual(["demo"]);
  });

  test("`reconnectOutcome` is the rule itself, on all four inputs", () => {
    const base = { baseHash: BASE, previewHash: PREVIEWED };
    expect(reconnectOutcome({ ...base, hash: PREVIEWED, exists: true })).toBe("saved");
    expect(reconnectOutcome({ ...base, hash: BASE, exists: true })).toBe("editing");
    expect(reconnectOutcome({ ...base, hash: "f".repeat(64), exists: true })).toBe("changed");
    // A create: no base hash, so nothing on disk means it did not land.
    expect(
      reconnectOutcome({ baseHash: null, previewHash: PREVIEWED, hash: undefined, exists: false }),
    ).toBe("editing");
    expect(
      reconnectOutcome({
        baseHash: null,
        previewHash: PREVIEWED,
        hash: "a".repeat(64),
        exists: true,
      }),
    ).toBe("changed");
  });

  test("an ordinary reconnect does not re-read (only a lost save does)", async () => {
    const h = harness();
    await opened(h);
    h.controller.setLink(false);
    h.controller.setLink(true);
    await h.flush();
    expect(h.readNames).toEqual(["demo"]);
  });
});

describe("create from a template", () => {
  test("sends mode:create, the draft, and the template's own prompt files", async () => {
    const h = harness({ name: null, saves: [okSave(), okSave()] });
    h.controller.create("plan-build-review-merge", "new-one", "a new one", {
      slug: { required: true },
    });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("editing");
    expect(h.state().mode).toBe("create");
    touched(h);
    h.controller.beginReview();
    await h.flush();
    const request = h.sent[0];
    expect(request?.mode).toBe("create");
    expect(request?.name).toBe("new-one");
    // A create has no base hash to send: the file did not exist.
    expect(request?.baseHash).toBeUndefined();
    const carried = (request?.prompts ?? []).map((p) => p.path).sort();
    expect(carried).toEqual(Object.keys(TEMPLATE.prompts).sort());
    const parsed = JSON.parse(request?.draft ?? "{}") as WorkflowDraft;
    expect(parsed.name).toBe("new-one");
    const round = asDraft(parsed);
    const steps = "draft" in round ? (round.draft.steps as unknown[]) : [];
    expect(steps.length).toBe(6);
  });

  test("the `blank` template starts with its one visible problem", async () => {
    const h = harness({ name: null });
    h.controller.create("blank", "fresh");
    h.controller.start();
    await h.flush();
    expect(h.state().problems).toEqual(["steps[0].run: should not be empty"]);
    expect(h.controller.canSave()).toBe(false);
  });

  test("a create is dirty by definition (it is not on disk)", async () => {
    const h = harness({ name: null });
    h.controller.create("plan-build-review-merge", "new-one", "", { slug: { required: true } });
    h.controller.start();
    await h.flush();
    expect(h.state().dirty).toBe(true);
    expect(h.controller.canSave()).toBe(true);
  });

  test("a template's prompts are NOT taken when a step does not read them", async () => {
    const h = harness({ name: null });
    h.controller.create("blank", "fresh");
    h.controller.start();
    await h.flush();
    touched(h);
    // `blank`'s single step reads no prompt file, so nothing is carried.
    h.controller.patch("step", { kind: "run", run: "bun test" });
    h.controller.beginReview();
    await h.flush();
    expect(h.sent[0]?.prompts).toEqual([]);
  });

  test("an unknown template is refused on the bar, not thrown", () => {
    const h = harness({ name: null });
    h.controller.create("nope", "fresh");
    expect(h.state().notice).toContain("No template");
  });
});

describe("discard", () => {
  test("a dirty draft asks 'Discard N changes?'", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    expect(h.controller.discardPrompt()).toBe(discardText(1));
    expect(discardText(1)).toBe("Discard 1 change?");
    expect(discardText(3)).toBe("Discard 3 changes?");
  });

  test("nothing changed → no question at all", async () => {
    const h = harness();
    await opened(h);
    expect(h.controller.discardPrompt()).toBeNull();
  });

  test("a saved draft is not a change to discard (the run is never touched)", async () => {
    const h = harness();
    await opened(h);
    await saved(h);
    expect(h.state().kind).toBe("saved");
    expect(h.controller.discardPrompt()).toBeNull();
  });

  test("discard restores the file as it was opened", async () => {
    const h = harness();
    await opened(h);
    const before = h.state().draft;
    touched(h);
    h.controller.discard();
    expect(h.state().draft).toEqual(before);
    expect(h.state().dirty).toBe(false);
  });
});

describe("the edit operations reach the draft", () => {
  test("an insert lands and names its step; the version bumps ONCE", async () => {
    const h = harness();
    await opened(h);
    h.controller.insert({ after: "gate" }, "run", "bun run lint");
    const draft = h.state().draft as WorkflowDraft;
    const steps = draft.steps as { id: string }[];
    expect(steps.map((s) => s.id)).toContain("lint");
    expect(draft.version).toBe(3);
    h.controller.setRetry("exec", 3);
    expect((h.state().draft as WorkflowDraft).version).toBe(3);
  });

  test("a refusal lands on the bar and leaves the draft alone (self-goto)", async () => {
    const h = harness();
    await opened(h);
    const before = h.state().draft;
    h.controller.setFail("exec", "exec");
    expect(h.state().notice).toBe("itself — use Retry");
    expect(h.state().draft).toEqual(before);
  });

  test("undo / redo walk the history", async () => {
    const h = harness();
    await opened(h);
    const before = h.state().draft;
    touched(h);
    expect(h.state().canUndo).toBe(true);
    h.controller.undo();
    expect(h.state().draft).toEqual(before);
    h.controller.redo();
    expect(JSON.stringify(h.state().draft)).toContain('"retry":2');
  });

  test("a delete reports what still points at it (the menu's note)", async () => {
    const h = harness();
    await opened(h);
    // `plan` is read by two prompt files: exec's and review's.
    const result = h.controller.edit((draft, prompts) => deleteStep(draft, "plan", prompts));
    expect(result?.dangling?.length).toBe(2);
  });

  test("edits are refused outside `editing` (Review is a read-only screen)", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    await h.flush();
    const before = h.state().draft;
    h.controller.setRetry("exec", 4);
    expect(h.state().draft).toEqual(before);
  });
});

describe("nothing lands after dispose", () => {
  test("a read in flight when the screen goes away changes nothing", async () => {
    const h = harness();
    h.controller.start();
    h.controller.dispose();
    await h.flush();
    expect(h.state().kind).toBe("opening");
  });

  test("a save in flight when the screen goes away changes nothing", async () => {
    const h = harness();
    await opened(h);
    touched(h);
    h.controller.beginReview();
    h.controller.dispose();
    await h.flush();
    expect(h.state().kind).toBe("editing");
  });
});

describe("the toast", () => {
  test("names the path, the version and the first 8 of the hash", () => {
    expect(savedToast({ hash: PREVIEWED, version: 3, path: ".tentacle/workflows/demo.yaml" })).toBe(
      `Saved .tentacle/workflows/demo.yaml · v3 · ${PREVIEWED.slice(0, 8)}`,
    );
    expect(PREVIEWED.slice(0, 8)).toBe("cccccccc");
  });
});
