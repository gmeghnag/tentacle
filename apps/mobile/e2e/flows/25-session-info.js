/**
 * Flow 25's last step (docs/feat/mobile-session-info.md, Owner decision 5): the
 * rename the phone's title tap performed must be the COMPUTER's title. A screen
 * claim would only say what the app drew (plan P9) — this reads `session/list` on
 * the daemon, so a rename that never reached `session/rename` fails here.
 *
 * The typed title is only whitespace-collapsed, so it is stored verbatim.
 */
const expected = "Renamed by flow 25";
const response = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${INFO_ID}`);
if (!response.ok) {
  throw new Error(`session-state failed: ${response.status} ${response.body}`);
}
const state = json(response.body).state;
if (state === null) {
  throw new Error("the session is GONE from the daemon: Session info must never close it");
}
if (state.title !== expected) {
  throw new Error(
    `the phone's rename never reached the computer: title is ${JSON.stringify(state.title)}, expected ${JSON.stringify(expected)}`,
  );
}
