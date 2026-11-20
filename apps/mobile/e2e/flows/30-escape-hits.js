/**
 * Flow 30's daemon-side truth (docs/feat/model-artifacts.md T8.1): what the
 * probe listener on the e2e host actually RECEIVED. A screen claim cannot prove
 * an escape did not happen; the listener can.
 *  - EXPECT=none  → no probe reached it (this checks BOTH the inert default and
 *    scripts-on-network-off: the page's own code runs and still reaches nothing);
 *  - EXPECT=fetch → the fetch probe arrived after "Allow network" (the listener
 *    works, so the checks above were not vacuous).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/escape-hits`);
if (!response.ok) {
  throw new Error(`escape-hits failed: ${response.status} ${response.body}`);
}
const hits = json(response.body).hits;
// Non-browser local clients that hit the port (never the artifact): reported, not counted.
output.escapeStrays = JSON.stringify(json(response.body).strays || []);
if (EXPECT === "none" && hits.length !== 0) {
  throw new Error(`the artifact ESCAPED: ${JSON.stringify(hits)}`);
}
if (EXPECT === "fetch" && !hits.includes("fetch")) {
  throw new Error(`Allow network did not let the fetch probe through: ${JSON.stringify(hits)}`);
}
