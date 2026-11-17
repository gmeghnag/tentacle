/**
 * One transcript row that throws must never take the app down
 * (docs/fix/mobile-crash-ibm-chart.md): the row is replaced by a small notice
 * and the failure is logged. This is the pure half — the words and the log
 * fields; `screens/transcript/RowGuard.tsx` is the boundary itself.
 */
import { type AppLogField, errorShape } from "./app-log.ts";

/** What a row that could not be drawn reads as. */
export const ROW_FALLBACK_TEXT = "couldn't display this item";

/**
 * The app-log fields of a row that threw: the row kind and the error CLASS —
 * never its message, which can carry daemon text (app-log F16).
 */
export function rowErrorFields(kind: string, error: unknown): Record<string, AppLogField> {
  return { source: "row", row: kind, ...errorShape(error) };
}
