/**
 * Flow 10's final assertion: the phone's approval (given AFTER the app came back)
 * is what ran the tool, so the file exists on the daemon's host.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=c.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error("c.txt was not written: the resumed approval never reached the tool");
}
output.wroteC = "true";
