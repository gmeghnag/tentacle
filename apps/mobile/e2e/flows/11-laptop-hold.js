/**
 * Flow 11: a LAPTOP `HOLD` turn, so a turn is genuinely mid-stream when the
 * daemon is killed — the cut the screen has to survive.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${ALPHA_ID}&prompt=HOLD%20across%20the%20restart`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.cutTurn = json(response.body).turnId;
