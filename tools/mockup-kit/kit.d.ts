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
/** One answer pill of a sheet (`permissionSheet({options})`). */
export interface SheetOption {
  readonly label: string;
  readonly primary?: boolean;
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
  permissionSheet(props?: {
    title?: string;
    tool?: string;
    detail?: string;
    diff?: readonly string[] | null;
    /** The answers; default: allow once / always allow / deny. Non-empty. */
    options?: readonly SheetOption[];
  }): Built;
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
