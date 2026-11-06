/**
 * What the plain `attach` tells when its eager attach fails
 * (docs/feat/session-settings-apply.md S3). Pure. Only the attach bound is
 * told: it replaces what used to be a silent, endless wait. Every other failure
 * keeps the quiet lazy fallback (the first prompt reports a link that is down).
 */
import { ATTACH_TIMEOUT_MS, AttachTimeoutError } from "@tentacle/client";

export function attachFailureNotice(error: unknown): string | null {
  if (!(error instanceof AttachTimeoutError)) {
    return null;
  }
  const seconds = Math.round(ATTACH_TIMEOUT_MS / 1000);
  return `Could not attach to the session: no answer from the container within ${seconds}s. It opens at your first prompt.`;
}
