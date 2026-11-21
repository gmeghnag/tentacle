/**
 * Flow 37: open a pairing window on project B's `serve` (in-process
 * `tentacle pair --project <B>`), and hand the flow its payload and B's row id.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-start?project=b`);
if (!response.ok) {
  throw new Error(`pair-start(b) failed: ${response.status} ${response.body}`);
}
const started = json(response.body);
output.payload = started.payload;
output.rowB = started.computerId;
if (output.rowB === output.rowA) {
  throw new Error(`project B's row id is A's (${output.rowA}): one record per project is broken`);
}
