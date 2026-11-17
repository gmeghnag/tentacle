/**
 * A drawer row's long-press menu and its delete confirmation
 * (docs/feat/mobile-session-actions.md S2, Owner Q2/Q3).
 *
 * Pure and React-free (AGENTS §7): the drawer maps these strings 1:1 to
 * `ActionSheet` actions and decides nothing. The wording of a delete is the
 * one the TUI already uses (owner R3, `packages/tui/src/sessions-panel.ts`
 * `deleteConfirmHint`), so the two devices say the same thing about a stopped
 * turn; the phone adds what only the phone knows — whether the session is the
 * one on screen, and whether anyone else is on it.
 */
import type { DrawerRow } from "./drawer-list.ts";

/** One item of the row menu. `destructive` is drawn in red by `ActionSheet`. */
export interface RowMenuItem {
  readonly label: string;
  readonly testID: string;
  readonly destructive?: boolean;
  readonly kind: "pin" | "unpin" | "rename" | "delete";
}

/**
 * The row's menu, in order: the pin switch first (it is the reversible one),
 * Rename, then Delete last and in red — the iOS action-sheet convention, and
 * the one place a mistake cannot be undone.
 */
export function rowMenu(row: Pick<DrawerRow, "pinned">): readonly RowMenuItem[] {
  return [
    row.pinned
      ? { kind: "unpin", label: "Unpin", testID: "drawer-row-unpin" }
      : { kind: "pin", label: "Pin to top", testID: "drawer-row-pin" },
    { kind: "rename", label: "Rename", testID: "drawer-row-rename" },
    { kind: "delete", label: "Delete", testID: "drawer-row-delete", destructive: true },
  ];
}

/** What the delete confirmation shows. `message` is one sentence, then the warnings. */
export interface DeleteConfirm {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: "Delete";
}

export interface DeleteConfirmContext {
  /** This row is the session on screen right now (Owner Q2: allowed, but said). */
  readonly isOpen: boolean;
}

/**
 * The confirmation a delete asks first. What is lost is the session and its
 * conversation; each warning is a daemon fact, never a guess:
 * `running` → its turn stops (the TUI's R3 rule); `attached > 0` → someone else
 * is on it (its count is other devices only, the phone's own attach is not
 * counted); `isOpen` → this is the one being read.
 */
export function deleteConfirm(
  row: Pick<DrawerRow, "title" | "running" | "attached">,
  context: DeleteConfirmContext,
): DeleteConfirm {
  const parts = ["Deletes this session and its conversation."];
  if (row.running) {
    parts.push("Its running turn will stop.");
  }
  if (row.attached > 0) {
    parts.push("It is open on another device.");
  }
  if (context.isOpen) {
    parts.push("This is the session you are in.");
  }
  return { title: row.title, message: parts.join(" "), confirmLabel: "Delete" };
}
