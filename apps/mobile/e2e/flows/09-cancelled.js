/**
 * Flow 09's daemon-truth assertion: the turn the phone stopped is no longer
 * running daemon-side. The cancel travelled the wire (`session/cancel{turnId}`)
 * — a phone-only change of the button would leave `running: true` here.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${ASK4_ID}`);
if (!response.ok) {
  throw new Error(`session-state failed: ${response.status} ${response.body}`);
}
const state = json(response.body).state;
if (state === null || state.running !== false) {
  throw new Error(`the foreign turn was not cancelled: ${JSON.stringify(state)}`);
}
output.afterStop = JSON.stringify(state);
