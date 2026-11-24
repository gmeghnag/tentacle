/**
 * Flow 44's final assertion (docs/feat/workflow-editor.md D8, slice 7c): the
 * phone's Save really wrote the file through `serve` — the YAML the Review
 * listed is on the daemon's disk, not just a toast on the screen.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/file-exists?file=.tentacle/workflows/wfedit.yaml`,
);
if (!response.ok) {
  throw new Error(`file-exists failed: ${response.status} ${response.body}`);
}
if (json(response.body).exists !== true) {
  throw new Error("wfedit.yaml was not written: the Save never reached the daemon");
}
output.wroteWorkflow = "true";
