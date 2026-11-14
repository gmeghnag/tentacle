/**
 * Flow 11's daemon-truth assertion: after the restart the daemon's own history is
 * readable again through a client that attaches — `serve` persisted the session
 * and the phone is back on it (the session was NOT recreated empty).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/history?session=${ALPHA_ID}`);
if (!response.ok) {
  throw new Error(`history failed: ${response.status} ${response.body}`);
}
const history = json(response.body).history;
if (typeof history.user !== "string" || history.user === "") {
  throw new Error(`the restarted daemon has no history: ${JSON.stringify(history)}`);
}
output.restartedHistory = JSON.stringify(history);
