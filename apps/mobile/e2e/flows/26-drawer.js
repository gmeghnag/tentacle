/**
 * Flow 26's last step (docs/feat/mobile-chrome.md S6, F6/F7): the drawer's
 * rename must be the COMPUTER's title, and the session the drawer switched away
 * from must still exist — a switch only detaches, it never closes. A screen
 * claim would only say what the app drew (plan P9); this reads the daemon.
 */
const expected = "Renamed in drawer 26";
const response = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${DRAWER_ID}`);
if (!response.ok) {
  throw new Error(`session-state failed: ${response.status} ${response.body}`);
}
const state = json(response.body).state;
if (state === null) {
  throw new Error("the session is GONE from the daemon: a drawer switch must never close it");
}
if (state.title !== expected) {
  throw new Error(
    `the drawer's rename never reached the computer: title is ${JSON.stringify(state.title)}, expected ${JSON.stringify(expected)}`,
  );
}
