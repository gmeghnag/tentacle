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
export interface Kit {
  readonly data: Record<string, unknown>;
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
