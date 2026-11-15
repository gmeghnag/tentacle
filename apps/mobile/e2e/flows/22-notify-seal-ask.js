/**
 * The approve/deny/reply flows' first action (docs/feat/mobile-notifications.md N8):
 * find the ask the daemon really has pending on the session this flow opened, then
 * seal a notification about THAT ask and place it.
 *
 * Why it must be that ask: the action the flow injects next is answered by the
 * app along the real path (`session/resolve_permission` keyed by `requestId`), so
 * a synthetic id would get `PermissionNotPending` and the flow's "daemon truth"
 * step would prove nothing.
 *
 * The session id comes from the flow (`ASK1_ID`, seeded per permission flow).
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
  throw new Error(`the daemon has no pending ask on ${session}: nothing to answer`);
}
const request = requests[0];
const sealed = http.get(
  `http://${MAESTRO_HOOKS}/seal-push?kind=ask&reply=1&session=${encodeURIComponent(
    session,
  )}&request=${encodeURIComponent(request)}`,
);
if (!sealed.ok) {
  throw new Error(`seal-push failed: ${sealed.status} ${sealed.body}`);
}
output.notifyRequest = String(request);
output.notifySession = String(session);
