/**
 * What a FAILED TURN says about the model that failed (docs/fix/
 * connect-model-error-drops-connection.md, decision (c)).
 *
 * A `connect` session reaches a `serve` daemon on another host: the model, its
 * endpoint and its API key are THAT host's (AGENTS §7 — the daemon is given the
 * local provider only for a pod reverse-tunnel, which `connect` does not use).
 * So a model error there is not something to fix here, and the bare provider
 * message ("model request failed with status 401: Invalid API Key") sends the
 * user looking in the wrong config. The hint names the right one.
 *
 * Only a MODEL-shaped failure gets it: a lost session, a closed session or a
 * link that stopped are not a model error and must not be dressed as one.
 */
import { oneLine } from "./commands.ts";

/**
 * "Something to fix in the daemon host's model config": a key (401/403), a wrong
 * URL or model (404), a proxy (407), or a connect / DNS / timeout failure.
 * A server-side generation error, a 400/5xx answer, or an output-limit or
 * stream cut is NOT that: it gets its own text only (docs/fix/
 * model-stream-error.md, decision (c)).
 */
const REMOTE_CONFIG_FAILURE =
  /status\s*(?:401|403|404|407)\b|\bECONN[A-Z]+\b|\bETIMEDOUT\b|\bEPIPE\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bE(?:HOST|NET)UNREACH\b|\bunreachable\b|could not connect|\bapi[-_ ]?key\b|\bunauthori[sz]ed\b|\bauthentication\b/i;

/** The most of a failed turn's own words the transcript shows. */
export const MODEL_ERROR_MAX = 600;

export const REMOTE_MODEL_HINT =
  'the daemon runs its own model: check its config and key with "tentacle config" on that host';

/**
 * The transcript line for a failed turn. `remote`: the session reaches a daemon
 * (`model: "remote"` in the TUI). A LOCAL failure renders exactly as before
 * (`String(error)`, the text every existing test pins); only a failure that
 * came over the wire gets the one-line, capped, hinted form — its words are the
 * daemon's, so they are untrusted input (AGENTS §7).
 */
export function modelErrorNotice(error: unknown, remote: boolean): string {
  if (!remote) {
    return String(error);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = oneLine(raw).trim();
  if (message === "") {
    return "turn failed";
  }
  const shown =
    message.length > MODEL_ERROR_MAX ? `${message.slice(0, MODEL_ERROR_MAX - 1)}…` : message;
  return REMOTE_CONFIG_FAILURE.test(shown) ? `${shown} — ${REMOTE_MODEL_HINT}` : shown;
}
