// A PDF worker stand-in that answers `ready`, then spins forever on the request:
// the shape of a hostile PDF that loops inside pdf.js. Only `terminate()` stops it.
declare const self: Worker;
self.onmessage = () => {
  for (;;) {}
};
postMessage("ready");
