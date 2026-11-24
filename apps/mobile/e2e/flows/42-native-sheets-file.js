/**
 * Flow 42's daemon-truth assertion (docs/feat/mobile-native-sheets.md S6, AGENTS
 * §9): a screenshot only says what was DRAWN. The last step proves the permission
 * sheet's answer really crossed the line — the tool the approval allowed wrote its
 * file in the run's scratch project.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/file-exists?file=ns42.txt`);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error(
    "ns42.txt was not written: the native permission sheet's approval never ran the tool",
  );
}
output.wroteNs42 = "true";
