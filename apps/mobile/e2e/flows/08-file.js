/**
 * Flow 08's daemon-truth assertion: the tool ACTUALLY RAN on the host — the file
 * the approval allowed exists in the run's scratch project. A deny variant
 * (09's own file) would assert the opposite, so this is not a tautology.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=a.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error("a.txt was not written: the approval never reached the tool");
}
output.wroteA = "true";
