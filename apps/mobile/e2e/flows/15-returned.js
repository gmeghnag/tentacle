/**
 * Flow 15's daemon-truth assertion: after the phone's Take, the daemon no longer
 * returns that row (it was reclaimed) and my own `composer-filled` shows the words
 * are the field's. A Take that only drew the text would leave `returned` non-empty.
 */
const queued = http.get(`http://${MAESTRO_HOOKS}/queue-state?session=${OTHER_ID}`);
if (!queued.ok) {
  throw new Error(`queue-state failed: ${queued.status} ${queued.body}`);
}
const state = json(queued.body).state;
if (state.returned.length !== 0) {
  throw new Error(
    `another device's row was not reclaimed by Take: ${JSON.stringify(state.returned)}`,
  );
}
output.returned = JSON.stringify(state);
