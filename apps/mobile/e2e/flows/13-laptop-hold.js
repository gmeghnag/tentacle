/**
 * Flow 13: a `GATED` turn on the flow's own session (`SENDNOW_ID`), so both steers
 * queue into a turn that never ends on its own — the send-now is what replaces it.
 * Not `HOLD`: a HOLD ends after the harness's 120 s, and on iOS 26 Maestro's two
 * type + send rounds took ~117–122 s, so the turn ended mid-tap
 * (docs/fix/mobile-e2e-reds.md). A gate ends only on the send-now's cancel.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${SENDNOW_ID}&prompt=GATED%20for%20send%20now`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.heldTurn = json(response.body).turnId;
