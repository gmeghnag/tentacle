/**
 * `hooks/trust` — daemon → client (the same direction as `model/stream`): the
 * daemon found project hooks (`.agents/hooks.json`) and asks the laptop whether
 * to run them this session (docs/feat/hooks-project-trust.md). The LAPTOP
 * decides and alone stores a decision; the daemon may be a pod (not trusted,
 * AGENTS §7), so every string is bounded and free of control characters before
 * it reaches the prompt. Additive: an older laptop answers `MethodNotFound`,
 * which the daemon treats as "declined".
 */
import { z } from "zod";
import { SessionIdSchema } from "./session.ts";

/** At most this many hooks / files listed in one request. */
export const MAX_TRUST_HOOKS = 100;

// C0/C1 controls and the bidi/format controls that can reorder what the
// prompt shows (U+200E/F, U+202A–U+202E, U+2066–U+2069).
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);

export const HooksTrustParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    /** The project folder (repo root) the hooks come from. */
    folder: line(4096),
    /** Hash of the hook definitions: a changed definition asks again. */
    hash: line(128),
    files: z.array(line(4096)).max(MAX_TRUST_HOOKS),
    hooks: z
      .array(
        z.object({ event: line(64), matcher: line(1024).optional(), command: line(4096) }).strict(),
      )
      .min(1)
      .max(MAX_TRUST_HOOKS),
    /** Whether these hooks may `allow` here (false in a pod, D6). Display only. */
    canAllow: z.boolean(),
  })
  .strict();
export type HooksTrustParams = z.infer<typeof HooksTrustParamsSchema>;

export const HooksTrustResultSchema = z.object({ trusted: z.boolean() }).strict();
export type HooksTrustResult = z.infer<typeof HooksTrustResultSchema>;
