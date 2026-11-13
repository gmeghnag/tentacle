/**
 * Maestro `runScript` body for flow 03 (docs/feat/mobile-app-shell.md): create a
 * session AFTER the list was read, then hand its id to the flow through
 * `output`, so the assertion names the row the hook actually made.
 * `MAESTRO_HOOKS` is the `127.0.0.1:<port>` the harness passes in the flow env;
 * `http.get(url)` is Maestro's built-in client (verified against
 * maestro-flows/javascript/make-http-requests).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/add-delta`);
if (!response.ok) {
  throw new Error(`add-delta failed: ${response.status} ${response.body}`);
}
output.deltaId = json(response.body).sessionId;
