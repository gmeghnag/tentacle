/**
 * Flow 30's daemon-side truth (docs/feat/model-artifacts.md T8.1): what the
 * probe listener on the e2e host actually RECEIVED. A screen claim cannot prove
 * an escape did not happen; the listener can.
 *  - EXPECT=none  → no probe reached it (network off: everything blocked);
 *  - EXPECT=fetch → the fetch probe arrived after "Allow network" (the listener
 *    works, so the first check was not vacuous).
 * PENDING: the `escape-hits` hook is part of the harness work S9 lands.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/escape-hits`);
if (!response.ok) {
  throw new Error(`escape-hits failed: ${response.status} ${response.body}`);
}
const hits = json(response.body).hits;
if (EXPECT === "none" && hits.length !== 0) {
  throw new Error(`the artifact ESCAPED with network off: ${JSON.stringify(hits)}`);
}
if (EXPECT === "fetch" && !hits.includes("fetch")) {
  throw new Error(`Allow network did not let the fetch probe through: ${JSON.stringify(hits)}`);
}
