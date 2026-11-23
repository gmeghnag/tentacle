#!/bin/sh
# The mobile e2e GATE (docs/feat/mobile-e2e-gate.md): the whole Maestro suite,
# unattended, on ONE given simulator — a local `serve` on a free port, the mock
# model, a clean Release install — then one summary table and an exit code.
#
#   scripts/e2e-gate.sh <udid> [run.ts flags…]    e.g. --app <path.app>, --flow-timeout 600
#   scripts/e2e-gate.sh <udidA>,<udidB> […]        the PARALLEL form: ONE Release
#     build installed on both, the flows split between them by their last recorded
#     durations, one merged summary and one exit code (docs/feat/e2e-parallel-gate.md).
#     Each half gets its own `serve`, mock model and Maestro device; the app build
#     is cached by content key, so a second run of the same tree skips xcodebuild.
#     `--no-app-cache` (or E2E_NO_APP_CACHE=1) forces a rebuild.
#
# Exit: 0 = every counted flow passed (known-bug and quarantined flows are
# listed, not counted); 1 = a counted flow failed or timed out; 2 = a missing
# prerequisite or a bad UDID; anything else = the build/install failed.
# Results (summary.txt/.json, each flow's screenshots + maestro.log):
# .tentacle/tmp/e2e-mobile/<runId>/ under the repo this script lives in — and, in
# the parallel form, one <runId>/sim-<udid8>/ per simulator inside it, with each
# child's own log next to the merged summary.
set -eu
udid="${1:-${E2E_SIM_UDID:-}}"
if [ -z "$udid" ]; then
  echo "usage: scripts/e2e-gate.sh <simulator-udid>[,<simulator-udid>…] [run.ts flags…]" >&2
  exit 2
fi
[ "$#" -gt 0 ] && shift
cd "$(dirname "$0")/.."
exec bun apps/mobile/e2e/run.ts --udid "$udid" "$@"
