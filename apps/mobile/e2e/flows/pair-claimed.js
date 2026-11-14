/**
 * A NEGATIVE assertion (docs/feat/mobile-pairing-screen.md 11b.1 flows 06/08): the
 * phone must NOT have claimed the code. A refused paste and a cancelled pairing
 * both promise "nothing was dialled"; an id on screen can only say what the app
 * DREW, so the daemon-side truth (did a claim arrive at `pair`?) is the hook.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-claimed`);
if (!response.ok) {
  throw new Error(`pair-claimed failed: ${response.status} ${response.body}`);
}
if (json(response.body).claimed) {
  throw new Error("the phone claimed the pairing code, but nothing should have been dialled");
}
output.claimed = "false";
