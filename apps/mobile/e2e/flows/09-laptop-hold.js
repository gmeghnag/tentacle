/**
 * Flow 09: a LAPTOP turn with `HOLD`, so it streams long enough for the phone to
 * see it running and to tap Stop (docs/feat/mobile-session-view.md 12c).
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${ASK4_ID}&prompt=HOLD%20from%20the%20laptop`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.laptopTurn = json(response.body).turnId;
