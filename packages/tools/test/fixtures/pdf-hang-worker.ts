// A PDF worker stand-in that answers `ready`, then spins forever on the request:
// the shape of a hostile PDF that loops inside pdf.js. Only `terminate()` stops it.
// The worker global scope is reached through `globalThis` (it IS `self` in a
// worker) rather than `declare const self`: that ambient declaration collides
// with the DOM lib's `self` when a typecheck loads the DOM lib.
const scope = globalThis as unknown as {
  onmessage: ((ev: unknown) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = () => {
  for (;;) {}
};
scope.postMessage("ready");
