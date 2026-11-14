/**
 * Flow 22's own opener (docs/feat/mobile-relay.md R6, "relay only"): open the
 * pairing window with NO `--address` of the harness's own, so the QR carries only
 * what the daemon's record does. `serve` binds loopback here, which contributes no
 * bind-derived address (`pair-addresses.ts`), and the record's relay address is
 * the record's only entry — the zero-configuration case the relay exists for, and
 * the one R5b made pairable at all.
 *
 * `ttlMs=-1` is the harness's flag for "the relay-only case" (a real `pair` TTL is
 * never negative): the window is opened WITHOUT the harness's own loopback
 * address, so the record's relay address is the QR's only one. Every other flow
 * uses `pair-start.js`.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-start?ttlMs=-1`);
if (!response.ok) {
  throw new Error(`pair-start failed: ${response.status} ${response.body}`);
}
const started = json(response.body);
if (started.relayOnly !== true) {
  throw new Error("the harness did not open a relay-only pairing window");
}
output.payload = started.payload;
output.computerId = started.computerId;
