/**
 * `22-notify-forged`'s action (docs/feat/mobile-notifications.md N8, F4/F5): seal a
 * notification about the REAL pending ask with a key that is NOT the pinned
 * computer's, so the app's HPKE-Auth check must refuse it.
 *
 * `seal-push?forged=1` uses a different sender static private key — the envelope
 * is internally consistent (its `k` matches the forged sender), so the app cannot
 * tell it apart before decrypting: the AEAD is what refuses it.
 */
const session = ASK1_ID;
if (typeof session !== "string" || session.length === 0) {
  throw new Error("ASK1_ID is not set by _pair");
}
const asked = http.get(
  `http://${MAESTRO_HOOKS}/pending-ask?session=${encodeURIComponent(session)}`,
);
if (!asked.ok) {
  throw new Error(`pending-ask failed: ${asked.status} ${asked.body}`);
}
const requests = json(asked.body).requests;
if (!Array.isArray(requests) || requests.length === 0) {
  throw new Error(`the daemon has no pending ask on ${session}: nothing to forge`);
}
const request = requests[0];
const sealed = http.get(
  `http://${MAESTRO_HOOKS}/seal-push?kind=ask&forged=1&session=${encodeURIComponent(
    session,
  )}&request=${encodeURIComponent(request)}`,
);
if (!sealed.ok) {
  throw new Error(`seal-push failed: ${sealed.status} ${sealed.body}`);
}
output.notifyForged = "placed";
