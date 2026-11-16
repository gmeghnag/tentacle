/**
 * Rename from the drawer (docs/feat/mobile-chrome.md Design 3 "Row actions",
 * F7, slice S6): long-press a row → Rename → `session/rename` by id (no open
 * needed). The decisions are `session-rename.ts`'s (`renamePlan`,
 * `renameErrorText`); this pins the drawer's own flow around them: a no-op
 * sends nothing, a failure keeps the field open with the person's text, a
 * success closes it and asks the list to refresh (the row keeps its old title
 * until the daemon's stored one is read back), and a double tap sends once.
 */
import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { createDrawerRename } from "../src/drawer-rename.ts";

function harness(answer: (title: string) => Promise<string>) {
  const sent: { computerId: string; sessionId: string; title: string }[] = [];
  const refreshed: string[] = [];
  const rename = createDrawerRename({
    rename: (computerId, sessionId, title) => {
      sent.push({ computerId, sessionId, title });
      return answer(title);
    },
    renamed: (computerId) => refreshed.push(computerId),
  });
  return { rename, sent, refreshed };
}

const ROW = { id: "s1", title: "Old title" };

describe("drawer rename", () => {
  test("begin opens the field on the row's current title", () => {
    const { rename } = harness(async (t) => t);
    expect(rename.state()).toBeNull();
    rename.begin("a", ROW);
    expect(rename.state()?.field).toEqual({ text: "Old title", saving: false, error: null });
    expect(rename.state()?.sessionId).toBe("s1");
    expect(rename.state()?.computerId).toBe("a");
  });

  test("unchanged or empty is a no-op: closes, sends nothing, no refresh", async () => {
    const { rename, sent, refreshed } = harness(async (t) => t);
    rename.begin("a", ROW);
    rename.setText("  Old   title ");
    await rename.submit();
    expect(rename.state()).toBeNull();
    rename.begin("a", ROW);
    rename.setText("   ");
    await rename.submit();
    expect(rename.state()).toBeNull();
    expect(sent).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  test("a too-long title is refused locally, the field stays open with the reason", async () => {
    const { rename, sent } = harness(async (t) => t);
    rename.begin("a", ROW);
    rename.setText("x".repeat(5000));
    await rename.submit();
    expect(sent).toEqual([]);
    expect(rename.state()?.field.error).toContain("Keep it under");
    expect(rename.state()?.field.text).toBe("x".repeat(5000));
  });

  test("success: sends by id on the row's computer, closes, refreshes that computer's list", async () => {
    const { rename, sent, refreshed } = harness(async (t) => `${t}`);
    rename.begin("b", ROW);
    rename.setText("New  name");
    await rename.submit();
    expect(sent).toEqual([{ computerId: "b", sessionId: "s1", title: "New name" }]);
    expect(rename.state()).toBeNull();
    expect(refreshed).toEqual(["b"]);
  });

  test("failure (F7): the field stays open with the text and the reason; no refresh", async () => {
    const { rename, refreshed } = harness(async () => {
      throw new Error("not connected to the daemon");
    });
    rename.begin("a", ROW);
    rename.setText("New");
    await rename.submit();
    expect(rename.state()?.field).toEqual({
      text: "New",
      saving: false,
      error: "not connected to the daemon",
    });
    expect(refreshed).toEqual([]);
  });

  test("an older daemon's MethodNotFound gets its own sentence", async () => {
    const { rename } = harness(async () => {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "x");
    });
    rename.begin("a", ROW);
    rename.setText("New");
    await rename.submit();
    expect(rename.state()?.field.error).toBe(
      "This computer's tentacle is too old to rename sessions.",
    );
  });

  test("a second Save while saving sends nothing more", async () => {
    let release: (t: string) => void = () => {};
    const { rename, sent } = harness(
      (t) =>
        new Promise<string>((resolve) => {
          release = () => resolve(t);
        }),
    );
    rename.begin("a", ROW);
    rename.setText("New");
    const first = rename.submit();
    expect(rename.state()?.field.saving).toBe(true);
    await rename.submit();
    expect(sent.length).toBe(1);
    release("New");
    await first;
    expect(rename.state()).toBeNull();
  });

  test("typing clears a shown error; cancel closes", async () => {
    const { rename } = harness(async () => {
      throw new Error("boom");
    });
    rename.begin("a", ROW);
    rename.setText("New");
    await rename.submit();
    rename.setText("Newer");
    expect(rename.state()?.field.error).toBeNull();
    rename.cancel();
    expect(rename.state()).toBeNull();
  });

  test("an answer that lands after cancel does not reopen, but still refreshes", async () => {
    let release: (t: string) => void = () => {};
    const { rename, refreshed } = harness(
      (t) =>
        new Promise<string>((resolve) => {
          release = () => resolve(t);
        }),
    );
    rename.begin("a", ROW);
    rename.setText("New");
    const pending = rename.submit();
    rename.cancel();
    release("New");
    await pending;
    expect(rename.state()).toBeNull();
    // The daemon DID rename it: the list must still be re-read, or the row lies.
    expect(refreshed).toEqual(["a"]);
  });

  test("subscribers hear every change", async () => {
    const { rename } = harness(async (t) => t);
    let calls = 0;
    const off = rename.subscribe(() => {
      calls += 1;
    });
    rename.begin("a", ROW);
    rename.setText("N");
    off();
    rename.cancel();
    expect(calls).toBe(2);
  });
});
