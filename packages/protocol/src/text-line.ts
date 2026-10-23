/**
 * One display line from a daemon that may be a pod (not trusted, AGENTS §7):
 * non-empty, bounded, free of control characters. Internal to the package
 * (not re-exported): a building block, not a wire type.
 */
import { z } from "zod";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;

export const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);
