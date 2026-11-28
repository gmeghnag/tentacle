/**
 * Flow 90 (docs/feat/mobile-ui-fluidity-s2.md): under the stream's load the
 * Thinking clock must have counted what the wall did, within 2 s. A label that
 * cannot be read is a failure.
 */
function clockSeconds(label) {
  const match = /^(?:(\d+) min )?(\d+) s$/.exec(label);
  if (match === null) {
    throw new Error(`unreadable thinking clock: "${label}"`);
  }
  return Number(match[1] || 0) * 60 + Number(match[2]);
}

const wall = (Date.now() - Number(output.clockAt)) / 1000;
const before = clockSeconds(String(output.clockLabel));
const counted = clockSeconds(String(maestro.copiedText)) - before;
if (Math.abs(counted - wall) > 2) {
  throw new Error(`thinking clock off wall time: counted ${counted} s in ${wall} s`);
}
