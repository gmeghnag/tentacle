/** Flow 17: the daemon is back on the same port; the outbox's `decide` runs on `up`. */
const response = http.get(`http://${MAESTRO_HOOKS}/start-serve`);
if (!response.ok) {
  throw new Error(`start-serve failed: ${response.status} ${response.body}`);
}
output.started = "true";
