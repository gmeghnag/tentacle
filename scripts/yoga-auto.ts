/**
 * Replacement for `yoga-wasm-web/auto` used only when building the standalone
 * binary. Upstream reads `yoga.wasm` from disk at runtime, which a compiled
 * binary has no filesystem for. The build plugin (scripts/build.ts) aliases
 * `yoga-wasm-web/auto` to this shim and supplies the wasm bytes (base64) through
 * the `virtual:yoga-wasm` module, so everything is embedded in the binary.
 */
// @ts-expect-error - provided by the build plugin's virtual module
import wasmBase64 from "virtual:yoga-wasm";
// @ts-expect-error - the instantiator (dist/index.js) wired in by the build plugin
import initYoga from "virtual:yoga-init";

const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
const Yoga = await initYoga(bytes);
export default Yoga;
