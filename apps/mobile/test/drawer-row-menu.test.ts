/**
 * A drawer row's long-press menu and delete confirmation
 * (docs/feat/mobile-session-actions.md S2): the items in order, the pin switch
 * worded from the row's own `pinned`, Delete last and destructive; and the
 * confirmation saying what is lost plus every daemon fact that applies
 * (running turn stops / open on another device / this is the session you are in).
 */
import { describe, expect, test } from "bun:test";
import { type DeleteConfirmContext, deleteConfirm, rowMenu } from "../src/drawer-row-menu.ts";

describe("rowMenu", () => {
  test("an unpinned row offers Pin to top first, Rename, then Delete (destructive, last)", () => {
    expect(rowMenu({ pinned: false })).toEqual([
      { kind: "pin", label: "Pin to top", testID: "drawer-row-pin" },
      { kind: "rename", label: "Rename", testID: "drawer-row-rename" },
      {
        kind: "delete",
        label: "Delete",
        testID: "drawer-row-delete",
        destructive: true,
      },
    ]);
  });

  test("a pinned row offers Unpin in the same place instead of Pin", () => {
    const items = rowMenu({ pinned: true });
    expect(items.map((i) => i.label)).toEqual(["Unpin", "Rename", "Delete"]);
    expect(items[0]).toEqual({ kind: "unpin", label: "Unpin", testID: "drawer-row-unpin" });
    // Only Delete is red.
    expect(items.filter((i) => i.destructive === true).map((i) => i.kind)).toEqual(["delete"]);
  });
});

const row = (over: { title?: string; running?: boolean; attached?: number } = {}) => ({
  title: over.title ?? "Fix the flaky test",
  running: over.running ?? false,
  attached: over.attached ?? 0,
});

const OPEN: DeleteConfirmContext = { isOpen: true };
const CLOSED: DeleteConfirmContext = { isOpen: false };

describe("deleteConfirm", () => {
  test("an idle row no one else is on: what is lost, nothing more", () => {
    expect(deleteConfirm(row(), CLOSED)).toEqual({
      title: "Fix the flaky test",
      message: "Deletes this session and its conversation.",
      confirmLabel: "Delete",
    });
  });

  test("a running row warns that its turn stops", () => {
    expect(deleteConfirm(row({ running: true }), CLOSED).message).toBe(
      "Deletes this session and its conversation. Its running turn will stop.",
    );
  });

  test("an attached row warns that it is open on another device", () => {
    expect(deleteConfirm(row({ attached: 2 }), CLOSED).message).toBe(
      "Deletes this session and its conversation. It is open on another device.",
    );
  });

  test("the open session says so (Owner Q2: allowed, but never silently)", () => {
    expect(deleteConfirm(row(), OPEN).message).toBe(
      "Deletes this session and its conversation. This is the session you are in.",
    );
  });

  test("every warning applies at once, in a fixed order", () => {
    expect(deleteConfirm(row({ running: true, attached: 1 }), OPEN).message).toBe(
      "Deletes this session and its conversation. Its running turn will stop. It is open on another device. This is the session you are in.",
    );
  });

  test("the title is the row's, untouched (a daemon string, drawn as plain Text)", () => {
    const hostile = "[tap here](https://evil.example)";
    expect(deleteConfirm(row({ title: hostile }), CLOSED).title).toBe(hostile);
  });
});
