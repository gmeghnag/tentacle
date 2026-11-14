/**
 * Flow 22's daemon-truth step (docs/feat/mobile-relay.md R6): the pairing PAYLOAD
 * carried the relay address and nothing else.
 *
 * The app's own screen can only say "It answers on 1 address" — it never shows a
 * URL, so an id on screen cannot prove WHICH address arrived (e2e-flows' rule:
 * a flow must end on truth the app cannot fake). This hook reads what `pair`
 * actually printed, which is what the QR and the pasted line carried.
 *
 * Throws on anything short of "exactly one address, and it is the relay's
 * `/d/<id>/e2e` shape" — so a future change that quietly puts a direct address
 * back into the list (or drops the relay's) is red here, not merely different.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/relay-qr`);
if (!response.ok) {
  throw new Error(`relay-qr failed: ${response.status} ${response.body}`);
}
const payload = json(response.body).payload;
if (typeof payload !== "string" || payload === "") {
  throw new Error(`the pairing payload is empty: ${JSON.stringify(payload)}`);
}
// The payload is `tentacle://pair?v=1&k=…&a=<address>&a=<address>…`; only the
// addresses matter here (`a`, repeated, in the phone's dial order).
const query = payload.slice(payload.indexOf("?") + 1);
const addresses = query
  .split("&")
  .filter((param) => param.startsWith("a="))
  .map((param) => decodeURIComponent(param.slice(2)));
if (addresses.length !== 1) {
  throw new Error(
    `the QR carries ${addresses.length} addresses, not exactly the relay's: ${JSON.stringify(addresses)}`,
  );
}
const only = addresses[0];
// `<relay>/d/<22-char id>/e2e`: the shape `relayAddress` builds and the app
// already dials. A direct `ws://192.168…/e2e` here would mean the zero-config QR
// regressed (`pair-addresses.ts` is supposed to contribute no bind-derived
// address for a loopback bind).
if (!/^wss?:\/\/[^/]+\/d\/[A-Za-z0-9_-]{22}\/e2e$/.test(only)) {
  throw new Error(`the QR's only address is not the relay's /d/<id>/e2e: ${JSON.stringify(only)}`);
}
output.relayAddress = only;
