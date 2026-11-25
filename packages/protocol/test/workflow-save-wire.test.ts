import { describe, expect, test } from "bun:test";
import {
  Method,
  RequestSchemas,
  WORKFLOW_DRAFT_MAX_CHARS,
  WORKFLOW_PATCH_MAX_CHARS,
  WORKFLOW_PROMPTS_MAX,
  WORKFLOW_PROMPT_FILE_MAX_CHARS,
  WORKFLOW_WRITE_FILES_MAX,
  WorkflowSaveParamsSchema,
  WorkflowSaveResultSchema,
  WorkflowSourceParamsSchema,
  WorkflowSourceResultSchema,
  isMethodName,
} from "../src/index.ts";

// docs/feat/workflow-editor.md slice 3a (D3): the editor's two ADDITIVE methods.
// Neither moves PROTOCOL_VERSION (an older daemon answers `MethodNotFound`, which
// the client maps to `unsupported`), so there is no `protocol.d/` note.

const hash = "a".repeat(64);

describe("session/workflow_source + session/workflow_save are registered methods", () => {
  test("both names, with their own param/result schemas", () => {
    expect(Method.WorkflowSource).toBe("session/workflow_source");
    expect(Method.WorkflowSave).toBe("session/workflow_save");
    expect(isMethodName("session/workflow_source")).toBe(true);
    expect(isMethodName("session/workflow_save")).toBe(true);
    expect(RequestSchemas[Method.WorkflowSource].params).toBe(WorkflowSourceParamsSchema);
    expect(RequestSchemas[Method.WorkflowSource].result).toBe(WorkflowSourceResultSchema);
    expect(RequestSchemas[Method.WorkflowSave].params).toBe(WorkflowSaveParamsSchema);
    expect(RequestSchemas[Method.WorkflowSave].result).toBe(WorkflowSaveResultSchema);
  });
});

describe("session/workflow_source", () => {
  test("params: a session and a workflow name, both required", () => {
    const ok = (p: unknown) => WorkflowSourceParamsSchema.safeParse(p).success;
    expect(ok({ sessionId: "s", name: "task" })).toBe(true);
    expect(ok({ sessionId: "s" })).toBe(false);
    expect(ok({ name: "task" })).toBe(false);
    // A `..` or an absolute path is not a name (it never becomes a path).
    expect(ok({ sessionId: "s", name: "../etc" })).toBe(false);
  });

  test("a readable file round-trips: path, text, the draft as JSON text, its prompts", () => {
    const result = {
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      text: "schemaVersion: 1\n",
      draft: '{"schemaVersion":1,"name":"task","version":3,"steps":[]}',
      prompts: [{ path: "prompts/gate.md", text: "review {{inputs.slug}}" }],
      hash,
      version: 3,
      canonical: false,
      context: { models: ["gpt-5"], agentTypes: ["general"] },
    };
    const parsed = WorkflowSourceResultSchema.safeParse(result);
    expect(parsed.success && parsed.data).toEqual(result);
  });

  test("a file that cannot be opened: `ok:false` with `unreadable` and NO draft", () => {
    const parsed = WorkflowSourceResultSchema.safeParse({
      ok: false,
      path: ".tentacle/workflows/task.yaml",
      unreadable: "a workflow must be a YAML mapping",
      text: "not: [a workflow",
    });
    expect(parsed.success).toBe(true);
    // `draft` is present iff the structure could be read: a result carrying both
    // would let an editor show an editable graph for a file it cannot edit.
    const both = WorkflowSourceResultSchema.safeParse({
      ok: false,
      path: "p",
      unreadable: "x",
      draft: "{}",
    });
    // The SCHEMA does not police that pairing (the daemon decides); what it does
    // police is the shape of each member, so a wrong-typed one is refused.
    expect(both.success).toBe(true);
    expect(
      WorkflowSourceResultSchema.safeParse({ ok: true, path: "p", draft: { steps: [] } }).success,
    ).toBe(false);
    expect(WorkflowSourceResultSchema.safeParse({ ok: true, path: "p", text: 5 }).success).toBe(
      false,
    );
  });

  test("the picker context carries model NAMES only, bounded", () => {
    const with_ = (models: string[]) =>
      WorkflowSourceResultSchema.safeParse({ ok: true, path: "p", context: { models } });
    expect(with_(["gpt-5"]).success).toBe(true);
    expect(with_(Array.from({ length: 65 }, (_, i) => `m${i}`)).success).toBe(false);
    // A name, never an id or a URL (§7): a bounded line, no control characters.
    expect(with_(["model\nid"]).success).toBe(false);
    expect(with_(["x".repeat(129)]).success).toBe(false);
    // Absent is legal: a session with no driver (`unavailable`) has no pickers.
    expect(WorkflowSourceResultSchema.safeParse({ ok: true, path: "p" }).success).toBe(true);
  });

  test("caps: errors are 20x300, the raw text the loader's byte cap, prompts the save's", () => {
    const withErrors = (errors: string[]) =>
      WorkflowSourceResultSchema.safeParse({ ok: false, path: "p", errors });
    expect(withErrors(["steps[0].run: is not a command"]).success).toBe(true);
    expect(withErrors(Array.from({ length: 21 }, () => "e")).success).toBe(false);
    expect(withErrors(["x".repeat(301)]).success).toBe(false);
    const text = (size: number) =>
      WorkflowSourceResultSchema.safeParse({ ok: true, path: "p", text: "x".repeat(size) });
    expect(text(256 * 1024).success).toBe(true);
    expect(text(256 * 1024 + 1).success).toBe(false);
    expect(WORKFLOW_DRAFT_MAX_CHARS).toBe(512 * 1024);
    expect(
      WorkflowSourceResultSchema.safeParse({
        ok: true,
        path: "p",
        draft: "x".repeat(WORKFLOW_DRAFT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("session/workflow_save", () => {
  const params = (extra: Record<string, unknown> = {}) => ({
    sessionId: "s",
    name: "task",
    mode: "create",
    draft: '{"schemaVersion":1,"name":"task","version":1,"steps":[]}',
    prompts: [{ path: "prompts/gate.md", text: "hi" }],
    dryRun: true,
    ...extra,
  });

  test("params: mode, the draft, its prompts and `dryRun` are all required", () => {
    const ok = (extra: Record<string, unknown>) =>
      WorkflowSaveParamsSchema.safeParse(params(extra)).success;
    expect(WorkflowSaveParamsSchema.safeParse(params()).success).toBe(true);
    expect(ok({ mode: "replace", baseHash: hash })).toBe(true);
    expect(ok({ mode: "upsert" })).toBe(false);
    expect(ok({ mode: "replace", baseHash: "short" })).toBe(false);
    // `dryRun` decides whether bytes are written: a default would let a client
    // that forgot it write a file it meant to preview.
    const { dryRun: _dropped, ...withoutDryRun } = params();
    expect(WorkflowSaveParamsSchema.safeParse(withoutDryRun).success).toBe(false);
    expect(ok({ sessionId: undefined })).toBe(false);
    expect(ok({ name: "" })).toBe(false);
  });

  test("the draft is bounded JSON TEXT, so 512 KiB is a real sentence", () => {
    // Mutation: `draft: z.record(z.unknown())` → the wire test red (the export
    // cannot represent a record, and its size would be unbounded).
    const at = (size: number) =>
      WorkflowSaveParamsSchema.safeParse(params({ draft: "x".repeat(size) })).success;
    expect(at(WORKFLOW_DRAFT_MAX_CHARS)).toBe(true);
    expect(at(WORKFLOW_DRAFT_MAX_CHARS + 1)).toBe(false);
    expect(WorkflowSaveParamsSchema.safeParse(params({ draft: { steps: [] } })).success).toBe(
      false,
    );
  });

  test("prompts are bounded in count and in size", () => {
    const prompts = (list: unknown[]) =>
      WorkflowSaveParamsSchema.safeParse(params({ prompts: list })).success;
    const one = { path: "prompts/a.md", text: "x" };
    expect(WORKFLOW_PROMPTS_MAX).toBe(32);
    expect(prompts(Array.from({ length: WORKFLOW_PROMPTS_MAX }, () => one))).toBe(true);
    expect(prompts(Array.from({ length: WORKFLOW_PROMPTS_MAX + 1 }, () => one))).toBe(false);
    expect(
      prompts([{ path: "prompts/a.md", text: "x".repeat(WORKFLOW_PROMPT_FILE_MAX_CHARS) }]),
    ).toBe(true);
    expect(
      prompts([{ path: "prompts/a.md", text: "x".repeat(WORKFLOW_PROMPT_FILE_MAX_CHARS + 1) }]),
    ).toBe(false);
    // An absolute or `..` prompt path is refused by the daemon's validator; the
    // wire refuses an empty one, which has no meaning at all.
    expect(prompts([{ path: "", text: "x" }])).toBe(false);
    // An empty list is legal: a workflow whose steps run commands only.
    expect(prompts([])).toBe(true);
  });

  test("a preview result round-trips: files, patches, hash, version and the notes", () => {
    const result: import("../src/index.ts").WorkflowSaveResult = {
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      hash,
      version: 4,
      approved: false,
      files: [
        { path: "prompts/gate.md", status: "new", added: 3, removed: 0, patch: "@@ -0,0 +1,3 @@" },
        { path: ".tentacle/workflows/task.yaml", status: "changed", added: 1, removed: 1 },
      ],
      alsoChanges: ["other"],
      running: "wf-2",
      schedules: ["sc-7"],
    };
    const parsed = WorkflowSaveResultSchema.safeParse(result);
    expect(parsed.success && parsed.data).toEqual(result);
    // A schedule id is a bounded line (`sc-N`); the wire does not re-derive the
    // `sc-` shape — a newer daemon's id is carried, never refused.
    expect(
      WorkflowSaveResultSchema.safeParse({ ok: true, schedules: ["x".repeat(65)] }).success,
    ).toBe(false);
  });

  test("a refusal carries the machine word and the human sentence", () => {
    const parsed = WorkflowSaveResultSchema.safeParse({
      ok: false,
      refusal: "changed",
      reason: ".tentacle/workflows/task.yaml changed since you opened it",
    });
    expect(parsed.success && parsed.data.refusal).toBe("changed");
    // A bounded free word, never an enum: a newer daemon's refusal still arrives.
    const newer = WorkflowSaveResultSchema.safeParse({ ok: false, refusal: "written-by-policy" });
    expect(newer.success && newer.data.refusal).toBe("written-by-policy");
    expect(WorkflowSaveResultSchema.safeParse({ ok: false, refusal: "two words" }).success).toBe(
      false,
    );
  });

  test("the file rows are capped: status is a word, a patch is 64 KiB", () => {
    expect(WORKFLOW_WRITE_FILES_MAX).toBe(33);
    const rows = (files: unknown[]) => WorkflowSaveResultSchema.safeParse({ ok: true, files });
    const row = { path: "p", status: "new", added: 0, removed: 0 };
    expect(rows(Array.from({ length: WORKFLOW_WRITE_FILES_MAX }, () => row)).success).toBe(true);
    expect(rows(Array.from({ length: WORKFLOW_WRITE_FILES_MAX + 1 }, () => row)).success).toBe(
      false,
    );
    expect(rows([{ ...row, status: "deleted" }]).success).toBe(false);
    expect(rows([{ ...row, added: -1 }]).success).toBe(false);
    expect(rows([{ ...row, patch: "x".repeat(WORKFLOW_PATCH_MAX_CHARS) }]).success).toBe(true);
    expect(rows([{ ...row, patch: "x".repeat(WORKFLOW_PATCH_MAX_CHARS + 1) }]).success).toBe(false);
    // `path` names each written file, so it is never absent.
    expect(rows([{ status: "new", added: 0, removed: 0 }]).success).toBe(false);
  });
});

describe("the frame budget the bounds were chosen for", () => {
  test("worst-case params and result each fit the daemon's 8 MiB inbound cap", () => {
    // packages/daemon/src/device-accept.ts DEFAULT_MAX_FRAME_BYTES, spelled
    // here rather than imported: @tentacle/protocol does not depend on the daemon.
    const frame = 8 * 1024 * 1024;
    const params =
      WORKFLOW_DRAFT_MAX_CHARS + WORKFLOW_PROMPTS_MAX * WORKFLOW_PROMPT_FILE_MAX_CHARS + 2 * 1024;
    const result =
      WORKFLOW_DRAFT_MAX_CHARS +
      256 * 1024 +
      WORKFLOW_PROMPTS_MAX * WORKFLOW_PROMPT_FILE_MAX_CHARS +
      WORKFLOW_WRITE_FILES_MAX * WORKFLOW_PATCH_MAX_CHARS +
      8 * 1024;
    expect(params).toBeLessThan(frame);
    expect(result).toBeLessThan(frame);
  });
});
