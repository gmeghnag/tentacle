/**
 * Build entrypoint for the PDF worker (docs/feat/pdf-read.md D2). It lives
 * HERE, next to `worker.ts`, not in `packages/tools`, so the compiled binary
 * embeds it at the same `$bunfs` root as `worker.ts`, the layout R0 proved.
 * The worker itself is `@tentacle/tools/pdf-worker`; `pdf-worker-url.ts` points
 * the extractor at this file.
 */
import "@tentacle/tools/pdf-worker";
