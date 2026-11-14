/**
 * Flow 13: a `HOLD` turn on the flow's own session (`SENDNOW_ID`), so both steers
 * queue into a turn that never ends on its own — the send-now is what replaces it.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${SENDNOW_ID}&prompt=HOLD%20for%20send%20now`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.heldTurn = json(response.body).turnId;
