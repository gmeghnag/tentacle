/**
 * `bun scripts/mockup-kit.ts calibrate [--run <e2e runDir>] [--chrome <path>]`
 * (docs/feat/mobile-mockup-kit.md Slice 3): each case of
 * tools/mockup-kit/calibration/cases.json — the kit's builders rendered by
 * headless Chrome — next to the real screenshot of the same state from an e2e
 * run, with a deterministic diff score. INFORMATIONAL, not a gate (Chrome and
 * UIKit rasterise differently): it makes drift visible and comparable run to run.
 * Missing Chrome / no run ⇒ exit 2 with what is missing; a missing shot is
 * "no reference", never scored against nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inlineHtml, kitStamp } from "./inline.ts";
import { type Image, type Rect, band, crop, decodePng, diffImages } from "./png.ts";
import { ROOT } from "./sources.ts";

const KIT = join(ROOT, "tools/mockup-kit");
const OUT = join(ROOT, ".tentacle/tmp/mockup-kit/calibration");
const E2E = join(ROOT, ".tentacle/tmp/e2e-mobile");
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
/** The e2e device's viewport (frame.css): iPhone 17 Pro, 402 × 874 pt @3x. */
const VIEW = { w: 402, h: 874, scale: 3 };

interface Case {
  readonly id: string;
  readonly flow: string;
  readonly shot: string;
  readonly themes: readonly string[];
  readonly crop: Rect;
  readonly masks: readonly Rect[];
  readonly screen: readonly (string | readonly [string, Record<string, unknown>])[];
}

function arg(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The newest e2e run dir (by mtime), or undefined. */
function latestRun(): string | undefined {
  if (!existsSync(E2E)) return undefined;
  const runs = readdirSync(E2E)
    .map((d) => join(E2E, d))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return runs[0];
}

/**
 * `<run>/ios<major>/<flow>/<shot>-<theme>.png`, searched under any ios<major> —
 * at the top of the run dir (a single-simulator run) or one level down in
 * `sim-<udid8>/` (a parallel run's shard, docs/feat/e2e-parallel-gate.md P7).
 */
function shotPath(run: string, c: Case, theme: string): string | undefined {
  for (const ios of readdirSync(run).filter((d) => d.startsWith("ios"))) {
    const p = join(run, ios, c.flow, `${c.shot}-${theme}.png`);
    if (existsSync(p)) return p;
  }
  for (const shard of readdirSync(run).filter((d) => d.startsWith("sim-"))) {
    for (const ios of readdirSync(join(run, shard)).filter((d) => d.startsWith("ios"))) {
      const p = join(run, shard, ios, c.flow, `${c.shot}-${theme}.png`);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** The page that renders one case with the kit (inlined, so Chrome loads it from file://). */
function casePage(c: Case, theme: string): string {
  const screen = JSON.stringify(c.screen);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="generated/tokens.css"><link rel="stylesheet" href="frame.css"><link rel="stylesheet" href="kit.css">
<style>body{margin:0}</style></head><body><div id="host"></div>
<script type="module">
import { K } from "./kit.js";
const parts = ${screen}.map((p) => (typeof p === "string" ? p : K[p[0]](p[1])));
K.screen(document.getElementById("host"), { theme: ${JSON.stringify(theme)}, bare: true, reduceMotion: true }, parts);
</script></body></html>`;
  return inlineHtml(html, KIT, (p) => readFileSync(p), kitStamp());
}

async function shoot(chrome: string, htmlPath: string, pngPath: string): Promise<Image> {
  const r = Bun.spawnSync(
    [
      chrome,
      "--headless=new",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      `--window-size=${VIEW.w},${VIEW.h}`,
      `--force-device-scale-factor=${VIEW.scale}`,
      "--virtual-time-budget=2000",
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0 || !existsSync(pngPath)) {
    throw new Error(`chrome failed (${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`);
  }
  return decodePng(new Uint8Array(await Bun.file(pngPath).arrayBuffer()));
}

interface Row {
  readonly id: string;
  readonly theme: string;
  readonly status: "scored" | "no-reference" | "error";
  readonly score?: number;
  readonly note?: string;
  readonly real?: string;
  readonly kit?: string;
}

export async function calibrateCommand(args: readonly string[]): Promise<number> {
  const chrome =
    arg(args, "--chrome") ?? process.env.CHROME ?? CHROME_PATHS.find((p) => existsSync(p));
  if (chrome === undefined || !existsSync(chrome)) {
    console.error(
      "mockup-kit calibrate: Chrome not found (install Chrome, or pass --chrome <path> / $CHROME)",
    );
    return 2;
  }
  const run = arg(args, "--run") ?? latestRun();
  if (run === undefined || !existsSync(run)) {
    console.error(
      `mockup-kit calibrate: no e2e run (looked in ${E2E}); run scripts/e2e-gate.sh or pass --run <dir>`,
    );
    return 2;
  }
  const { cases } = (await Bun.file(join(KIT, "calibration/cases.json")).json()) as {
    cases: Case[];
  };
  const rows: Row[] = [];
  for (const c of cases) {
    for (const theme of c.themes) {
      const real = shotPath(run, c, theme);
      if (real === undefined) {
        rows.push({
          id: c.id,
          theme,
          status: "no-reference",
          note: `no ${c.shot}-${theme}.png (flow ${c.flow} did not run)`,
        });
        continue;
      }
      try {
        const page = join(OUT, `${c.id}-${theme}.html`);
        const kitPng = join(OUT, `${c.id}-${theme}.kit.png`);
        await Bun.write(page, casePage(c, theme));
        const kit = await shoot(chrome, page, kitPng);
        const shot = decodePng(new Uint8Array(await Bun.file(real).arrayBuffer()));
        const local = c.masks.map((m) => ({ ...m, x: m.x - c.crop.x, y: m.y - c.crop.y }));
        const r = diffImages(crop(shot, c.crop), crop(kit, c.crop), local);
        rows.push({ id: c.id, theme, status: "scored", score: r.score, real, kit: kitPng });
      } catch (e) {
        rows.push({
          id: c.id,
          theme,
          status: "error",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Bun.write(
    join(OUT, "report.json"),
    `${JSON.stringify({ run, stamp: kitStamp(), rows }, null, 2)}\n`,
  );
  await Bun.write(join(OUT, "index.html"), reportPage(run, rows));
  const scored = rows.filter((r) => r.status === "scored").length;
  console.log(
    `mockup-kit calibrate: ${scored} scored, ${rows.length - scored} unscored → ${join(OUT, "index.html")}`,
  );
  return 0;
}

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Real crop · kit crop · score, per case; the band as glyph + word, never colour alone. */
function reportPage(run: string, rows: readonly Row[]): string {
  const body = rows
    .map((r) => {
      const b = r.score === undefined ? null : band(r.score);
      const verdict = b
        ? `${b.glyph} ${b.label} · ${(r.score ?? 0).toFixed(4)}`
        : `— ${r.status}: ${escHtml(r.note ?? "")}`;
      const imgs =
        r.real && r.kit
          ? `<img src="file://${escHtml(r.real)}" width="201"> <img src="file://${escHtml(r.kit)}" width="201">`
          : "";
      return `<tr><td>${escHtml(r.id)}</td><td>${r.theme}</td><td>${verdict}</td><td>${imgs}</td></tr>`;
    })
    .join("\n");
  const unscored = rows.filter((r) => r.status !== "scored").length;
  return `<!doctype html><meta charset="utf-8"><title>mockup-kit calibration</title><body style="font:14px system-ui"><h1>Calibration</h1><p>run: ${escHtml(run)} · ${unscored} unscored · informational, not a gate</p><table border="1" cellpadding="6">${body}</table>`;
}
