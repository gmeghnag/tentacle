/** Flow 15: a `HOLD` turn on the flow's own session, for the laptop's own steer. */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${OTHER_ID}&prompt=HOLD%20another%20device`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.heldTurn = json(response.body).turnId;
