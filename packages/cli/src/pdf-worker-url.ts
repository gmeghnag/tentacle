/**
 * Point the PDF extractor at the CLI's worker entrypoint (`./pdf-worker.ts`),
 * with the same `new URL("./…", import.meta.url)` form as the daemon worker
 * (`local-runtime.ts`), which resolves both from source and in `$bunfs`.
 * Imported for its effect by `main.ts` and `worker.ts`: a daemon runs in either.
 */
import { setPdfWorkerUrl } from "@tentacle/tools";

export const PDF_WORKER_URL = new URL("./pdf-worker.ts", import.meta.url).href;
setPdfWorkerUrl(PDF_WORKER_URL);
