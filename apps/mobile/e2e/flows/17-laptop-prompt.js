/**
 * Flow 17: the laptop runs a turn on the SAME session while the phone's item waits —
 * the "something changed since you wrote it" case `decide` must refuse to auto-send.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${CHANGED_ID}&prompt=SLOW%20laptop%20moved%20first`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.laptopTurn = json(response.body).turnId;
