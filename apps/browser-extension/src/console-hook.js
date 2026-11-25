// MAIN-world console hook, injected by ops.js ONLY into tabs a session owns
// (never a manifest content script: the user's other pages are not touched).
// It forwards console calls and uncaught errors to the isolated content script
// (page.js) as a string `CustomEvent` — never `postMessage`, which every page
// listener would see. Everything it carries is untrusted page data; the daemon
// masks and frames it (docs/feat/browser-inspect.md §3/§4).
(() => {
  const FLAG = "__tentacleConsoleHook";
  if (globalThis[FLAG]) return;
  Object.defineProperty(globalThis, FLAG, { value: true, enumerable: false });
  const emit = (level, text, stack) => {
    try {
      const detail = JSON.stringify({
        level,
        text: String(text).slice(0, 2000),
        ...(stack ? { stack: String(stack).slice(0, 4000) } : {}),
      });
      document.dispatchEvent(new CustomEvent("__tentacle_console", { detail }));
    } catch {
      // never break the page
    }
  };
  const fmt = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      const err = args.find((a) => a instanceof Error);
      emit(level, args.map(fmt).join(" "), err?.stack);
      return original.apply(this, args);
    };
  }
  addEventListener("error", (e) =>
    emit("exception", e.message, e.error?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`),
  );
  addEventListener("unhandledrejection", (e) => emit("rejection", fmt(e.reason), e.reason?.stack));
  emit("hook", "");
})();
