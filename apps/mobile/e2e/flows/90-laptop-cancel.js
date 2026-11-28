/** Flow 90: the laptop stops the stream once the hub opens are done. */
const response = http.get(`http://${MAESTRO_HOOKS}/laptop-cancel?session=${PERF_ID}`);
if (!response.ok) {
  throw new Error(`laptop-cancel failed: ${response.status} ${response.body}`);
}
output.cancelled = "true";
