/**
 * A spilled tool result as data (docs/feat/tui-spill-note.md): mirrors
 * `@tentacle/core`'s `ToolResultSpill`. It rides `tool_call_update` (live) and
 * the tool `ChatMessage` (snapshot, `open{messages}`), so a client shows a
 * short note instead of the model's banner and never parses `content`.
 * Optional and additive on strip schemas: an older peer drops it.
 */
import { z } from "zod";

export const ToolResultSpillSchema = z.object({
  /** Length of the full output. */
  chars: z.number().int().nonnegative(),
  /** Where the full output was saved; absent = it could not be written. */
  path: z.string().min(1).max(4096).optional(),
  /** The preview's first and last parts (`tail` is "" when nothing was omitted). */
  head: z.string(),
  tail: z.string(),
  /** Characters between `head` and `tail`. */
  omitted: z.number().int().nonnegative(),
});
export type WireToolResultSpill = z.infer<typeof ToolResultSpillSchema>;
