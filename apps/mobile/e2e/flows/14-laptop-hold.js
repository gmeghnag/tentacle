/**
 * Flow 14: a `HOLD` turn on the flow's own session (`RETURNED_ID`), which the next
 * step stops from the laptop — the phone's queued steer is then its returned row.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${RETURNED_ID}&prompt=HOLD%20stopped%20elsewhere`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.heldTurn = json(response.body).turnId;
