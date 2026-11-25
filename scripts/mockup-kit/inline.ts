/**
 * `bun scripts/mockup-kit.ts inline <in.html> [out.html]` (docs/feat/mobile-mockup-kit.md
 * Slice 2): a SELF-CONTAINED snapshot of a mockup. Stylesheets become <style>
 * (their url()s data: URIs — the Figtree faces too), module scripts and their
 * relative imports become data: URLs (kit.js with its kit-data.json folded in),
 * images become data: URIs, and the page is stamped
 * `<meta name="mockup-kit" content="<tree sha of tools/mockup-kit>">`. So a
 * proposal synced to .tentacle/mockups/ stays frozen when the kit changes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { ROOT } from "./sources.ts";

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const isLocal = (p: string): boolean => !/^(?:[a-z]+:|#|\/\/)/i.test(p);

export type Reader = (path: string) => Buffer;

function dataUri(path: string, bytes: Buffer): string {
  const mime = MIME[extname(path).toLowerCase()];
  if (mime === undefined) {
    throw new Error(`mockup-kit inline: no MIME type for ${path}`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** A stylesheet with every relative url() as a data: URI. */
function inlineCss(css: string, base: string, read: Reader): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, _q, ref: string) =>
    isLocal(ref) ? `url("${dataUri(ref, read(resolve(base, ref)))}")` : whole,
  );
}

/** A JS module with its relative imports as data: URLs (recursively); JSON imports folded in. */
function inlineModule(js: string, base: string, read: Reader): string {
  const json = js.replace(
    /import\s+(\w+)\s+from\s+(["'])([^"']+\.json)\2\s+with\s*\{\s*type:\s*["']json["']\s*\};?/g,
    (whole, name: string, _q, ref: string) =>
      isLocal(ref) ? `const ${name} = ${read(resolve(base, ref)).toString("utf8").trim()};` : whole,
  );
  return json.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+\.js)\2/g,
    (whole, lead: string, q: string, ref: string) => {
      if (!isLocal(ref)) return whole;
      const path = resolve(base, ref);
      const body = inlineModule(read(path).toString("utf8"), dirname(path), read);
      return `${lead}${q}${dataUri(path, Buffer.from(body, "utf8"))}${q}`;
    },
  );
}

/** The snapshot of `html` (whose relative refs resolve against `base`). */
export function inlineHtml(html: string, base: string, read: Reader, stamp: string): string {
  let out = html.replace(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    (whole, ref: string) => {
      if (!isLocal(ref)) return whole;
      const path = resolve(base, ref);
      return `<style data-from="${ref}">\n${inlineCss(read(path).toString("utf8"), dirname(path), read)}\n</style>`;
    },
  );
  out = out.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (whole, a: string, ref: string, b: string) => {
      if (!isLocal(ref)) return whole;
      const path = resolve(base, ref);
      return `<script${a}${b}>\n${inlineModule(read(path).toString("utf8"), dirname(path), read)}\n</script>`;
    },
  );
  out = out.replace(
    /(<script\b[^>]*type=["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_w, open: string, body: string, close: string) =>
      `${open}${inlineModule(body, base, read)}${close}`,
  );
  out = out.replace(
    /(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi,
    (whole, lead: string, q: string, ref: string) =>
      isLocal(ref) ? `${lead}${q}${dataUri(ref, read(resolve(base, ref)))}${q}` : whole,
  );
  const meta = `<meta name="mockup-kit" content="${stamp}">`;
  return /<head[^>]*>/i.test(out)
    ? out.replace(/<head[^>]*>/i, (h) => `${h}\n${meta}`)
    : `${meta}\n${out}`;
}

/** The kit's identity: its git tree at HEAD, `+dirty` when the working copy differs. */
export function kitStamp(root: string = ROOT): string {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const tree = git(["rev-parse", "HEAD:tools/mockup-kit"]);
  const sha = tree.exitCode === 0 ? tree.stdout.toString().trim() : "uncommitted";
  const dirty =
    git(["status", "--porcelain", "--", "tools/mockup-kit"]).stdout.toString().trim() !== "";
  return dirty ? `${sha}+dirty` : sha;
}

export async function inlineCommand(args: readonly string[]): Promise<number> {
  const [input, output] = args;
  if (input === undefined) {
    console.error("usage: bun scripts/mockup-kit.ts inline <in.html> [out.html]");
    return 2;
  }
  const inPath = resolve(input);
  if (!existsSync(inPath)) {
    console.error(`mockup-kit inline: ${input} not found`);
    return 2;
  }
  const outPath = output ? resolve(output) : inPath.replace(/\.html?$/i, ".inline.html");
  const html = inlineHtml(
    readFileSync(inPath, "utf8"),
    dirname(inPath),
    (p) => readFileSync(p),
    kitStamp(),
  );
  await Bun.write(outPath, html);
  console.log(`mockup-kit: wrote ${outPath}`);
  return 0;
}

export const KIT_INDEX = join(ROOT, "tools/mockup-kit/index.html");
