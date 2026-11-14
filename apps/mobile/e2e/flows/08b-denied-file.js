/**
 * Flow 08b's daemon-truth assertion (docs/feat/mobile-session-view.md 12c): the
 * refusal reached the daemon, so the tool did NOT run — the file it would have
 * written does not exist. The mirror image of flow 08's `08-file.js`.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=denied.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== false) {
  throw new Error("denied.txt EXISTS: the refusal never reached the tool");
}
output.deniedAbsent = "true";
