/**
 * The view-model of THE ask component (docs/fix/mobile-ask-surfaces.md D3), the
 * same card in the session sheet and on the workflow run screen. Pure: it maps
 * the sheet's `asking` state plus the origin to what `AskCard.tsx` draws; the
 * component owns colours, glyph art and spacing only.
 *
 * Trust: `origin` words are pod-supplied display text. The glyph comes from the
 * origin's `kind`, never from the text.
 */
import { type AskOrigin, originWords } from "@tentacle/client";
import { type CommandPreview, commandPreview } from "./command-preview.ts";
import type { SheetOptionId, SheetState } from "./permission-sheet.ts";

export type AskGlyph =
  | "polpetto"
  | "arrow.triangle.branch"
  | "point.topleft.down.to.point.bottomright.curvepath";

export interface AskCtx {
  readonly origin: AskOrigin;
  /** Monospace columns that fit the command box. */
  readonly cols: number;
  /** Milliseconds since the ask appeared; null when unknown. */
  readonly ageMs: number | null;
  /** The session's auto-accept link exists (offer the toggle in the menu). */
  readonly hasAutoAccept: boolean;
}

export interface AskAction {
  readonly optionId: "reject_once" | "allow_once";
  readonly label: string;
}

export interface AskMenuItem {
  readonly id: "allow_always" | "reply" | "auto_accept";
  readonly label: string;
}

export type AskCardView =
  | {
      readonly kind: "asking";
      readonly origin: {
        readonly glyph: AskGlyph;
        readonly lead: string;
        readonly rest: string;
        readonly age: string | null;
      };
      readonly title: string;
      readonly preview: CommandPreview | null;
      readonly armed: boolean;
      /** Deny first, Allow once last (Deny is never the primary look). */
      readonly actions: readonly [AskAction, AskAction];
      /** The rare options behind `…`; null when there are none (no `…`). */
      readonly menu: readonly AskMenuItem[] | null;
      readonly alsoAsked: string | null;
    }
  | { readonly kind: "returned"; readonly text: string; readonly notice: string };

export function glyphFor(origin: AskOrigin): AskGlyph {
  switch (origin.kind) {
    case "main":
      return "polpetto";
    case "subagent":
      return "arrow.triangle.branch";
    case "workflow":
      return "point.topleft.down.to.point.bottomright.curvepath";
  }
}

/** `12s` / `3m` / `1h`. */
export function askAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  return `${Math.floor(s / 3600)}h`;
}

export function askCard(state: SheetState, ctx: AskCtx): AskCardView | null {
  if (state.kind === "idle") {
    return null;
  }
  if (state.kind === "returned") {
    return { kind: "returned", text: state.text, notice: state.notice };
  }
  const label = (id: SheetOptionId, fallback: string): string =>
    state.options.find((o) => o.optionId === id)?.label ?? fallback;
  const has = (id: SheetOptionId): boolean => state.options.some((o) => o.optionId === id);
  const menu: AskMenuItem[] = [];
  if (has("allow_always")) {
    menu.push({ id: "allow_always", label: label("allow_always", "") });
  }
  if (has("reply")) {
    menu.push({ id: "reply", label: label("reply", "") });
  }
  if (ctx.hasAutoAccept) {
    menu.push({ id: "auto_accept", label: "Auto-accept" });
  }
  const words = originWords(ctx.origin);
  const detail = state.request.detail;
  return {
    kind: "asking",
    origin: {
      glyph: glyphFor(ctx.origin),
      lead: words.lead,
      rest: words.rest,
      age: ctx.ageMs === null ? null : askAge(ctx.ageMs),
    },
    title: state.request.title,
    preview:
      detail === undefined || detail === "" ? null : commandPreview(detail, { cols: ctx.cols }),
    armed: state.armed,
    actions: [
      { optionId: "reject_once", label: label("reject_once", "Deny") },
      { optionId: "allow_once", label: label("allow_once", "Allow once") },
    ],
    menu: menu.length > 0 ? menu : null,
    alsoAsked: state.alsoAsked.length > 0 ? `Also asked on ${state.alsoAsked.join(", ")}` : null,
  };
}
