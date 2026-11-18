#!/bin/sh
# The mobile e2e GATE (docs/feat/mobile-e2e-gate.md): the whole Maestro suite,
# unattended, on ONE given simulator — a local `serve` on a free port, the mock
# model, a clean Release install — then one summary table and an exit code.
#
#   scripts/e2e-gate.sh <udid> [run.ts flags…]    e.g. --app <path.app>, --flow-timeout 600
#
# Exit: 0 = every counted flow passed (known-bug and quarantined flows are
# listed, not counted); 1 = a counted flow failed or timed out; 2 = a missing
# prerequisite or a bad UDID; anything else = the build/install failed.
# Results (summary.txt/.json, each flow's screenshots + maestro.log):
# .tentacle/tmp/e2e-mobile/<runId>/ under the repo this script lives in.
set -eu
udid="${1:-${E2E_SIM_UDID:-}}"
if [ -z "$udid" ]; then
  echo "usage: scripts/e2e-gate.sh <simulator-udid> [run.ts flags…]" >&2
  exit 2
fi
[ "$#" -gt 0 ] && shift
cd "$(dirname "$0")/.."
exec bun apps/mobile/e2e/run.ts --udid "$udid" "$@"
