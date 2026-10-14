// Stub for `react-devtools-core`. Ink imports it and calls `connectToDevTools()`
// only in its (unused) DEV mode; we never enable that. Providing a no-op lets
// the app bundle into a standalone binary (`bun build --compile`) without
// pulling in the real, heavy devtools package.
const noop = () => {};
module.exports = { connectToDevTools: noop, connectWithCustomMessagingProtocol: noop };
module.exports.default = module.exports;
