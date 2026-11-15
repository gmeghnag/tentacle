/**
 * Flip the simulator to `NAME` (light|dark) for flow 24's screenshot pairs
 * (mobile-ui-polish slice 6). The harness runs `simctl ui <udid> appearance`.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/appearance?name=${NAME}`);
if (!response.ok) {
  throw new Error(`appearance failed: ${response.status} ${response.body}`);
}
