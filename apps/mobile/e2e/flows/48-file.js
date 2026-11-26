/**
 * Flow 48's final assertion: the approval given on the screen «Open the session»
 * led to is what ran the tool, so the file exists on the daemon's host.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=w48.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error("w48.txt was not written: the approval never reached the tool");
}
output.wrote48 = "true";
