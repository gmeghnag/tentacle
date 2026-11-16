// Loads the PDF worker's prelude in a Worker (never in the test thread: it
// silences the console) and reports what it did to `console` and `fetch`.
import "../../src/pdf/quiet.ts";

const fetched = await fetch("http://127.0.0.1:9/").then(
  () => "fetched",
  (error: Error) => `refused: ${error.message}`,
);
postMessage({
  fetch: fetched,
  consoleQuiet: [console.log, console.info, console.warn, console.error, console.debug].every(
    (fn) => fn.toString() === "() => {}",
  ),
});
