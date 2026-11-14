/**
 * Flow 14's daemon-truth assertions: (1) the turn really was stopped, and (2) my row
 * was RECLAIMED — the daemon's `returned` no longer lists it. The banner on screen
 * only says what was drawn (plan P9); this is what the daemon holds.
 */
const state = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${RETURNED_ID}`);
if (!state.ok) {
  throw new Error(`session-state failed: ${state.status} ${state.body}`);
}
const session = json(state.body).state;
if (session === null || session.running !== false) {
  throw new Error(`the laptop's turn still runs: ${JSON.stringify(session)}`);
}
const queued = http.get(`http://${MAESTRO_HOOKS}/queue-state?session=${RETURNED_ID}`);
if (!queued.ok) {
  throw new Error(`queue-state failed: ${queued.status} ${queued.body}`);
}
const after = json(queued.body).state;
if (after.returned.length !== 0) {
  throw new Error(`my returned row was not reclaimed: ${JSON.stringify(after.returned)}`);
}
output.returned = JSON.stringify(after);
