/**
 * The PDF worker's prelude, imported FIRST so it runs before pdf.js loads.
 * pdf.js prints polyfill warnings at import time ("Cannot polyfill DOMMatrix",
 * R0); a worker's console is the process's terminal, which Ink owns during a
 * TUI session (AGENTS §7 "never write raw to the terminal"). And no code path
 * in pdf.js may reach the network: `fetch` throws.
 */
const quiet = () => {};
console.log = quiet;
console.info = quiet;
console.warn = quiet;
console.error = quiet;
console.debug = quiet;
globalThis.fetch = Object.assign(
  () => Promise.reject(new Error("network access is disabled in the PDF worker")),
  { preconnect: () => {} },
) as unknown as typeof fetch;
