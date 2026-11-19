/**
 * The 34-hub-* flows' world change (docs/feat/mobile-e2e-gate.md): the LAPTOP runs
 * `PROMPT` on this flow's session, answering any ask `allow`. Sent from the
 * laptop, not typed, because iOS's smart punctuation curls the quotes of the mock
 * model's `CALL <tool> {json}` directive.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${HUBITEM_ID}&answer=allow&prompt=${encodeURIComponent(PROMPT)}`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
