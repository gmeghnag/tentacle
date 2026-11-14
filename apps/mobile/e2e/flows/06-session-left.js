/**
 * Flow 06's post-back assertion (docs/feat/mobile-session-view.md 12c): the
 * phone's `leave()` DETACHED, it did not end the session. `session-state` reads
 * `session/list` on the daemon (`attached`, `archived`), so this is daemon truth,
 * not a screen claim.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${ALPHA_ID}`);
if (!response.ok) {
  throw new Error(`session-state failed: ${response.status} ${response.body}`);
}
const state = json(response.body).state;
if (state === null) {
  throw new Error("the session is GONE from the daemon: leaving must never close it");
}
if (state.archived !== false) {
  throw new Error(
    `leaving archived the session (a session/close was sent): ${JSON.stringify(state)}`,
  );
}
if (state.attached > 1) {
  throw new Error(`the phone is still attached after leaving: ${JSON.stringify(state)}`);
}
output.leftState = JSON.stringify(state);
