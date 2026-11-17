/**
 * The drawer's row actions are WIRED, not just built
 * (docs/feat/mobile-session-actions.md S2). `SessionsDrawer.tsx` and `App.tsx`
 * are `.tsx` Bun cannot import (React Native's sources are Flow), so the seam is
 * pinned from the source, like `icon-weights.test.ts`:
 *
 * - the long-press plays the menu haptic BEFORE opening the sheet;
 * - the sheet's items come from `rowMenu` (so Pin/Unpin/Rename/Delete cannot
 *   drift from the pure module) and Delete is the destructive one;
 * - the delete confirmation is a second `ActionSheet` fed by `deleteConfirm`;
 * - `App.tsx` wires the controller to `pinSession` / `deleteSession` and to the
 *   drawer's own `nextAfterCurrent` — the two client calls the plan names.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const drawer = readFileSync(join(APP, "src", "screens", "SessionsDrawer.tsx"), "utf8");
const app = readFileSync(join(APP, "App.tsx"), "utf8");

describe("S2 · the drawer's row menu", () => {
  test("the long-press plays the row-menu haptic, then opens the sheet", () => {
    const onLongPress = /onLongPress=\{\(\) => \{([\s\S]*?)\}\}/.exec(drawer)?.[1] ?? "";
    expect(onLongPress).toContain("playHaptic(rowMenuHaptic())");
    expect(onLongPress).toContain("props.onRowMenu(row)");
    // The haptic comes first: the feedback is the press, not a late afterthought.
    expect(onLongPress.indexOf("playHaptic")).toBeLessThan(onLongPress.indexOf("onRowMenu"));
  });

  test("the a11y hint is about actions, not rename only", () => {
    expect(drawer).toContain('accessibilityHint="Long-press for actions"');
    expect(drawer).not.toContain("Long-press to rename");
  });

  test("the menu items are `rowMenu`'s, forwarded with their kind", () => {
    const actions = /function menuActions[\s\S]*?\n\}/.exec(drawer)?.[0] ?? "";
    expect(actions).toContain("rowMenu(row)");
    expect(actions).toContain("props.onRowAction(row, item.kind)");
    expect(actions).toContain("destructive");
    // No hard-coded item list survives beside it.
    expect(drawer).not.toContain('label: "Rename"');
  });

  test("a second sheet shows the delete confirmation, worded by `deleteConfirm`", () => {
    const sheet =
      /<ActionSheet\n {8}palette=\{palette\}\n {8}visible=\{props.deleteTarget !== null\}[\s\S]*?\/>/.exec(
        drawer,
      )?.[0];
    expect(sheet).toBeDefined();
    expect(sheet).toContain(
      "deleteConfirm(props.deleteTarget, { isOpen: props.deleteTarget.current })",
    );
    expect(sheet).toContain('testID: "drawer-delete-confirm"');
    expect(sheet).toContain('cancelTestID="drawer-delete-cancel"');
    // The confirm is the destructive action of that sheet.
    expect(sheet).toContain("destructive: true");
  });

  test("the row offers its new testIDs and a pin glyph", () => {
    for (const id of ["drawer-pinned", "drawer-action-error"]) {
      expect(drawer.includes(id)).toBe(true);
    }
    expect(drawer).toContain('name="pin"');
  });
});

describe("S2 · App.tsx wires the controller to the two client calls", () => {
  test("pin and delete go to the ROW's computer through the link registry", () => {
    expect(app).toContain("createDrawerRowActions({");
    expect(app).toContain("link.client.pinSession(sessionId, pinned)");
    expect(app).toContain("link.client.deleteSession(sessionId)");
  });

  test("the re-read is the listed computer's controller, never a local guess", () => {
    expect(app).toContain("void controllerRef.current.refresh();");
  });

  test("the next row after a delete is the drawer's own projection", () => {
    expect(app).toContain("nextAfterCurrent: () => rowActionsRef.current.next");
    expect(app).toContain("next: list.nextAfterCurrent?.id ?? null");
  });

  test("Pin/Unpin is dispatched, Delete asks first, Rename keeps its field", () => {
    const onRowAction =
      /onRowAction=\{\(row, kind\) => \{([\s\S]*?)\n {6}\}\}/.exec(app)?.[1] ?? "";
    expect(onRowAction).toContain('kind === "rename"');
    expect(onRowAction).toContain('kind === "delete"');
    expect(onRowAction).toContain("setDeleteTarget(row)");
    expect(onRowAction).toContain("rowActions.pin(listed,");
  });
});
