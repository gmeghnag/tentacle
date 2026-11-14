/** Flow 17: the daemon goes away — the phone composes offline (flow 17). */
const response = http.get(`http://${MAESTRO_HOOKS}/stop-serve`);
if (!response.ok) {
  throw new Error(`stop-serve failed: ${response.status} ${response.body}`);
}
output.stopped = "true";
