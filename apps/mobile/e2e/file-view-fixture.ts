/**
 * Flow 41's file (docs/feat/mobile-file-view.md, Validation part 1): one HTML
 * page with a `<style>` and a `<script>`, written NEW by the turn's `fs_write`,
 * then read (a range), edited once (`fs_edit`) and edited twice in one call
 * (`fs_multi_edit`, the mockup's variant B: a pixel array swapped for another).
 * Long enough that every collapsed body cuts at the preview and says how many
 * lines it hides.
 */
const PAGE = [
  "<!doctype html>",
  '<html lang="it">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>Entrate di Polpetto</title>",
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<style>",
  "/* Layout: a wrap of phone cards */",
  ":root {",
  "  --bg: #eceef0; --fg: #1c2125;",
  "  --muted: #5c646c; --line: #d2d7db;",
  "}",
  "body { margin: 0; background: var(--bg); color: var(--fg); }",
  "main { display: flex; flex-wrap: wrap; gap: 24px; padding: 32px; }",
  ".card { width: 390px; border: 1px solid var(--line); border-radius: 18px; }",
  ".card h2 { font-size: 15px; color: var(--muted); }",
  "canvas { image-rendering: pixelated; width: 100%; }",
  "</style>",
  "</head>",
  "<body>",
  "<main>",
  "  <h1>Entrate e uscite di Polpetto</h1>",
  '  <section class="card"><h2>Elicottero</h2><canvas id="heli"></canvas></section>',
  '  <section class="card"><h2>Mimetico</h2><canvas id="camo"></canvas></section>',
  '  <section class="card"><h2>Palloncino</h2><canvas id="balloon"></canvas></section>',
  "</main>",
  "<script>",
  "// The scenes, in the order the gallery plays them.",
  "export const SCENES = [",
  '  { k: "heli", dur: 9.6, tag: "proposta" },',
  "];",
  "",
  'const UFO0 = ["....HHHHHHH....", "...HGGHHHHHH...", "..HGHHHHHHHHH.."];',
  'const UFO1 = UFO0.map((r, i) => (i === 4 ? "LCCYCCYCCYCCYCL" : r));',
  'const BALLOON = ["..RRRRR..", ".RGGRRRR.", "RGGRRRRRR"];',
  "const BANNER = [",
  '  "..BBBBBBBBBBBBBBBBBBBBBBBBBBB..",',
  '  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",',
  '  "BBBBBBBBBBBBBWWWWWWWWWWWWWBBBBBB",',
  "];",
  "",
  'const PALETTE = { B: "#1c2125", W: "#ffffff", R: "#d64545", G: "#f2b8b8" };',
  "",
  "function draw(id, rows, scale = 6) {",
  "  const canvas = document.getElementById(id);",
  '  const ctx = canvas.getContext("2d");',
  "  canvas.width = rows[0].length * scale;",
  "  canvas.height = rows.length * scale;",
  "  rows.forEach((row, y) => {",
  "    [...row].forEach((cell, x) => {",
  '      if (cell === ".") return;',
  '      ctx.fillStyle = PALETTE[cell] ?? "#888888";',
  "      ctx.fillRect(x * scale, y * scale, scale, scale);",
  "    });",
  "  });",
  "}",
  "",
  "function play(scene, at = 0) {",
  "  const frame = Math.floor(at / 120) % 2 === 0 ? UFO0 : UFO1;",
  '  draw(scene.k, scene.k === "balloon" ? BALLOON : frame);',
  "  if (at < scene.dur * 1000) {",
  "    requestAnimationFrame(() => play(scene, at + 16));",
  "  }",
  "}",
  "",
  'draw("heli", BANNER, 4);',
  "SCENES.forEach((scene) => play(scene));",
  "</script>",
  "</body>",
  "</html>",
  "",
].join("\n");

export const FILE_VIEW_PAGE: string = PAGE;

/** The single `fs_edit`: one scene tagged, two added (the mockup's EDIT, +3 −1). */
export const FILE_VIEW_EDIT = {
  old_string: '  { k: "heli", dur: 9.6, tag: "proposta" },',
  new_string: [
    '  { k: "heli", dur: 9.6 }, // approvato 22/11',
    '  { k: "camo", dur: 5.4 },',
    '  { k: "balloon", dur: 6.6 },',
  ].join("\n"),
} as const;

/** The `fs_multi_edit`: the banner swapped for a notification card, and its use with it. */
export const FILE_VIEW_MULTI_EDITS = [
  {
    old_string: [
      "const BANNER = [",
      '  "..BBBBBBBBBBBBBBBBBBBBBBBBBBB..",',
      '  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",',
      '  "BBBBBBBBBBBBBWWWWWWWWWWWWWBBBBBB",',
      "];",
    ].join("\n"),
    new_string: [
      "const NOTIF_A = [",
      '  "....KKKKKKKKKKKKKKKKKK....",',
      '  "...KCCCCCCCCCCCCCCCCCCK...",',
      '  "..KCCCCCCCCCCCCCCCCCCCCK..",',
      '  "..KCCCCCCCCCCCCCCCCCCCCK..",',
      '  "...KCCCCCCCCCCCCCCCCCCK...",',
      '  "....KKKKKKKKKKKKKKKKKK....",',
      "];",
      'const NOTIF_B = NOTIF_A.map((r) => r.replaceAll("C", "Y"));',
    ].join("\n"),
  },
  {
    old_string: 'draw("heli", BANNER, 4);',
    new_string: 'draw("heli", NOTIF_A, 4);\nsetTimeout(() => draw("heli", NOTIF_B, 4), 800);',
  },
] as const;
