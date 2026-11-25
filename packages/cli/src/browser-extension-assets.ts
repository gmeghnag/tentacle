import manifest from "../../../apps/browser-extension/manifest.json" with { type: "text" };
/**
 * The unpacked extension, EMBEDDED in this build (docs/feat/browser-inspect.md
 * B5 addition 3): `tentacle browser install` writes these files to
 * `<configDir>/browser/extension`, so it works from the compiled binary
 * (`~/bin/tentacle`), where `apps/browser-extension` does not exist next to it.
 * `with { type: "text" }` makes the bundler inline each file's content.
 *
 * A file added to `apps/browser-extension/{manifest.json,src/}` must be added
 * here too: `browser-install.test.ts` fails while one is missing or stale.
 */
// Each `@ts-expect-error`: TS cannot type a JS / HTML file imported AS TEXT
// (TS7016 / TS2307); Bun inlines its content as a string.
// @ts-expect-error see above
import background from "../../../apps/browser-extension/src/background.js" with { type: "text" };
// @ts-expect-error see above
import consoleHook from "../../../apps/browser-extension/src/console-hook.js" with { type: "text" };
// @ts-expect-error see above
import ops from "../../../apps/browser-extension/src/ops.js" with { type: "text" };
// @ts-expect-error see above
import page from "../../../apps/browser-extension/src/page.js" with { type: "text" };
// @ts-expect-error see above
import popupHtml from "../../../apps/browser-extension/src/popup.html" with { type: "text" };
// @ts-expect-error see above
import popup from "../../../apps/browser-extension/src/popup.js" with { type: "text" };

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Relative path under the extension folder → file content. */
export const EXTENSION_ASSETS: Readonly<Record<string, string>> = {
  "manifest.json": text(manifest),
  "src/background.js": text(background),
  "src/console-hook.js": text(consoleHook),
  "src/ops.js": text(ops),
  "src/page.js": text(page),
  "src/popup.html": text(popupHtml),
  "src/popup.js": text(popup),
};
