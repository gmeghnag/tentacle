/** Types for the kit's pure builders, for the TypeScript tests that import kit.js. */
export interface Built {
  readonly html: string;
  readonly a11y: string;
}
export interface TuiBuilt extends Built {
  /** Plain text per grid row (what calibration compares). */
  readonly cells: readonly string[];
}
type Builder = (props?: Record<string, unknown>) => Built;
/** One answer capsule of the ask card (`askCard({actions})` / `permissionSheet({options})`). */
export interface SheetOption {
  readonly label: string;
  readonly primary?: boolean;
}
/**
 * Who asked, as `ask-origin.ts` gives it: the KIND picks the glyph (never the
 * words), `lead`/`rest`/`age` are the one-line label.
 */
export interface AskOriginProps {
  /** `main` = Polpetto's silhouette, `subagent` = the branch, `workflow` = the curve path. */
  readonly kind?: "main" | "subagent" | "workflow";
  readonly lead?: string;
  readonly rest?: string;
  readonly age?: string;
  /** The one-row form's short label, and the asks queued behind it (`+N`). */
  readonly short?: string;
  readonly more?: number;
}
/** An E2 row: a `control` slot (stepper / segmented / switch / chevron) and a `mono` value. */
export interface RowProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly value?: string;
  readonly icon?: string;
  readonly control?: string;
  readonly mono?: boolean;
}
export interface Kit {
  readonly data: Record<string, unknown>;
  /** The approval sheet: THE ask card inside the sheet frame (D7). */
  permissionSheet(props?: {
    title?: string;
    /** The sheet's accessible name (the card has no tool row). */
    tool?: string;
    detail?: string;
    diff?: readonly string[] | null;
    origin?: AskOriginProps;
    /** The answers; default: allow once / always allow / deny. Non-empty. */
    options?: readonly SheetOption[];
  }): Built;
  /** THE ask (D4): origin row, title, the 4-row command, `… Deny Allow once`. */
  askCard(props?: {
    origin?: AskOriginProps;
    title?: string;
    command?: string;
    expanded?: boolean;
    /** The rare options behind `…`; absent/empty draws none. */
    menu?: readonly string[] | null;
    alsoAsked?: string;
    armed?: boolean;
    on?: "sheet" | "page";
    /** Replaces the default Deny / Allow once pair (the sheet's own answers). */
    actions?: string | null;
  }): Built;
  /** The one-row form: the peek detent and the banner. Never draws an answer. */
  askSlim(props?: { title?: string; origin?: AskOriginProps; go?: string }): Built;
  /** The ask inside the formSheet frame; only the peek is undimmed. */
  askSheet(props?: { detent?: "peek" | "ask" | "large"; inner?: string }): Built;
  toast(props?: { text?: string; action?: string }): Built;
  bigButton(props?: { text?: string; tone?: "accent" | "warn"; disabled?: boolean }): Built;
  row(props: RowProps): Built;
  band(props?: { label?: string; rows?: readonly RowProps[] }): Built;
  readonly tui: {
    fromAnsi(text: string | readonly string[]): TuiBuilt;
    transcriptRow(name: string, opts?: { theme?: "dark" | "light"; bare?: boolean }): TuiBuilt;
    slot(props?: {
      seconds?: number;
      frame?: number;
      label?: string;
      theme?: "dark" | "light";
    }): TuiBuilt;
    inputBox(props?: {
      state?: "empty" | "draft";
      placeholder?: string;
      theme?: "dark" | "light";
    }): TuiBuilt;
  };
  extend(name: string, builder: (props: Record<string, unknown>) => Built | string): Builder;
  breatheKeyframes(): string;
  readonly [component: string]: unknown;
}
export declare const K: Kit;
export declare const KIT: { readonly data: Record<string, unknown> };
export declare function breatheKeyframes(): string;
export default K;
