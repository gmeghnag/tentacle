/**
 * Writes `apps/mobile/assets/diagram/renderer.html` (docs/feat/model-diagrams.md
 * D6): the daemon's pinned mermaid (`packages/tools`, the one install) inlined
 * with the driver, for the phone's hidden renderer — offline, no CDN.
 *
 *   bun apps/mobile/scripts/gen-diagram-renderer.ts
 *
 * Run it after bumping `mermaid` in `packages/tools/package.json`;
 * `test/diagram-renderer-page.test.ts` fails until the asset matches.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RENDERER_PAGE_PATH, rendererPage } from "../src/diagram-renderer-page.ts";

const root = join(import.meta.dir, "..", "..", "..");
const dir = join(root, "packages/tools/node_modules/mermaid");
const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
  version: string;
};
const js = readFileSync(join(dir, "dist/mermaid.min.js"), "utf8");
const out = join(root, RENDERER_PAGE_PATH);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rendererPage({ js, version }));
console.log(`wrote ${RENDERER_PAGE_PATH} (mermaid ${version}, ${js.length} chars)`);
