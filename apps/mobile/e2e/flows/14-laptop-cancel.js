/**
 * Flow 14: the LAPTOP stops the running turn, which leaves the phone's queued steer
 * with no turn to drain it — the daemon returns it to its writer (F10).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/laptop-cancel?session=${RETURNED_ID}`);
if (!response.ok) {
  throw new Error(`laptop-cancel failed: ${response.status} ${response.body}`);
}
output.cancelled = "true";
