/**
 * The ask card's view-model (docs/fix/mobile-ask-surfaces.md D3, S4).
 */
import { describe, expect, test } from "bun:test";
import { askOrigin } from "@tentacle/client";
import type { PermissionRequest } from "@tentacle/core";
import { type AskCtx, askAge, askCard } from "../src/ask-card.ts";
import { createPermissionSheet } from "../src/permission-sheet.ts";

function ask(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "shell",
    level: "ask",
    title: "Run a shell command",
    detail: "echo hi",
    input: {},
    ...over,
  };
}

async function stateOf(req: PermissionRequest) {
  const sheet = createPermissionSheet({ now: () => 1000, onChange: () => {} });
  void sheet.requester(req, { signal: new AbortController().signal });
  await Promise.resolve();
  return sheet.view();
}

const ctx = (over: Partial<AskCtx> = {}): AskCtx => ({
  origin: askOrigin({}),
  cols: 40,
  ageMs: null,
  hasAutoAccept: false,
  ...over,
});

describe("askCard", () => {
  test("idle has no card; a returned ask passes through", () => {
    expect(askCard({ kind: "idle" }, ctx())).toBeNull();
    const back = askCard(
      { kind: "returned", text: "no", cause: "settled" as never, notice: "n" },
      ctx(),
    );
    expect(back).toEqual({ kind: "returned", text: "no", notice: "n" });
  });

  test("a workflow_approve has menu null (no `…`)", async () => {
    const v = askCard(await stateOf(ask({ kind: "workflow_approve" })), ctx());
    expect(v?.kind === "asking" && v.menu).toBeNull();
  });

  test("Deny comes first and Allow once last; Deny is never the primary look", async () => {
    const v = askCard(await stateOf(ask()), ctx());
    expect(v?.kind === "asking" && v.actions.map((a) => a.optionId)).toEqual([
      "reject_once",
      "allow_once",
    ]);
  });

  test("Always allow only when offered; reply only with `reply`; auto-accept only with a link", async () => {
    const plain = askCard(await stateOf(ask()), ctx());
    expect(plain?.kind === "asking" && plain.menu?.map((m) => m.id)).toEqual(["allow_always"]);
    const full = askCard(
      await stateOf(ask({ reply: { maxChars: 10 }, suggestion: { prefix: "git" } as never })),
      ctx({ hasAutoAccept: true }),
    );
    expect(full?.kind === "asking" && full.menu?.map((m) => m.id)).toEqual([
      "allow_always",
      "reply",
      "auto_accept",
    ]);
    expect(full?.kind === "asking" && full.menu?.[0]?.label).toContain("git");
  });

  test("the glyph follows the kind, never the text", async () => {
    const st = await stateOf(ask());
    const g = (origin: AskCtx["origin"]) => {
      const v = askCard(st, ctx({ origin }));
      return v?.kind === "asking" ? v.origin.glyph : null;
    };
    expect(g(askOrigin({}))).toBe("polpetto");
    expect(g(askOrigin({ agent: { type: "x", description: "d" } }))).toBe("arrow.triangle.branch");
    const wf = askCard(st, ctx({ origin: askOrigin({ workflow: { name: "Main agent" } }) }));
    expect(wf?.kind === "asking" && wf.origin.glyph).toBe(
      "point.topleft.down.to.point.bottomright.curvepath",
    );
    expect(wf?.kind === "asking" && wf.origin.lead).toBe("Main agent");
  });

  test("origin words, age and the command preview", async () => {
    const v = askCard(
      await stateOf(ask({ detail: "a\nb\nc\nd\ne\nf" })),
      ctx({
        origin: askOrigin({
          workflow: { name: "wf", stepId: "gen", index: 1, count: 5 },
        }),
        ageMs: 125_000,
      }),
    );
    expect(v?.kind === "asking" && v.origin).toMatchObject({
      lead: "wf",
      rest: "step gen · 2 of 5",
      age: "2m",
    });
    expect(v?.kind === "asking" && v.preview?.more).toBe(2);
    const none = askCard(await stateOf(ask({ detail: undefined })), ctx());
    expect(none?.kind === "asking" && none.preview).toBeNull();
  });

  test("askAge", () => {
    expect([askAge(12_000), askAge(180_000), askAge(3_700_000), askAge(-5)]).toEqual([
      "12s",
      "3m",
      "1h",
      "0s",
    ]);
  });
});
