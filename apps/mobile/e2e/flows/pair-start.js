/**
 * `_pair` step 1 (docs/feat/mobile-pairing-screen.md 11b.1): open a pairing
 * window in the harness's own `serve` (in-process `tentacle pair`, P6) and hand
 * the payload line to the flow through `output`, so the paste is the REAL line
 * the computer printed. `PAIR_TTL_MS` lets a flow ask for a short window
 * (`07-pair-expired`).
 */
const ttl = typeof PAIR_TTL_MS === "undefined" ? "" : `?ttlMs=${PAIR_TTL_MS}`;
const response = http.get(`http://${MAESTRO_HOOKS}/pair-start${ttl}`);
if (!response.ok) {
  throw new Error(`pair-start failed: ${response.status} ${response.body}`);
}
const started = json(response.body);
output.payload = started.payload;
output.computerId = started.computerId;
