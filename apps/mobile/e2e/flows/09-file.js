/**
 * Flow 09's final assertion: the LAPTOP's approval is what ran the tool, so the
 * file exists even though the phone never tapped anything.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=b.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error("b.txt was not written: the laptop's answer never reached the tool");
}
output.wroteB = "true";
