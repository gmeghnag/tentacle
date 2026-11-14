/** Flow 15: the writer leaves — its returned row is nobody's to auto-claim (QR2). */
const response = http.get(`http://${MAESTRO_HOOKS}/laptop-detach?session=${OTHER_ID}`);
if (!response.ok) {
  throw new Error(`laptop-detach failed: ${response.status} ${response.body}`);
}
output.detached = "true";
