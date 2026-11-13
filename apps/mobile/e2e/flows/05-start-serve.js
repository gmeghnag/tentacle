/**
 * Maestro `runScript` body (docs/feat/mobile-app-shell.md): calls one harness
 * hook so a flow can change the world mid-run without the harness guessing at
 * timings. `MAESTRO_HOOKS` is the `127.0.0.1:<port>` the harness passes in the
 * flow env; `http.get(url)` is Maestro's built-in client (verified against
 * maestro-flows/javascript/make-http-requests).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/start-serve`);
if (!response.ok) {
  throw new Error(`hook start-serve failed: ${response.status} ${response.body}`);
}
output.hookStatus = `start-serve: ${response.status}`;
