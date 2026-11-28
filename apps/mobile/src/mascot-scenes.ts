/**
 * Polpetto's nine entrances for the EMPTY session (docs/feat/mobile-mascot-scenes.md,
 * owner decisions 22/11). Pure and framework-free (AGENTS §7 "logic lives in pure
 * modules"): the owner's 9×9 drawing, the nine palettes, the nine scenes as
 * `frameAt(scene, tMs, run) → Op[]` in GRID UNITS, the grid → points projection,
 * and the "never the same scene twice in a row" rule. `ui/MascotScene.tsx` only
 * draws the result.
 *
 * The spec is the mockup `docs/feat/mobile-mascot-scenes-mockup.html` — its
 * `SCENES` array is ported here verbatim (timings, sprites, paths, spellings of
 * every `Math.round`), so a divergence from it is a bug and not taste. Only two
 * things are NOT the mockup's:
 *
 *  - **Anchoring** (`homeAt`): the mockup draws a 390×700 reference screen with
 *    the composer at y=610; the app's layer is the measured BAND between the
 *    header and the composer. So the home is re-hung from the band's bottom edge
 *    (owner decision 1: centred, just above the composer) and every op's travel
 *    is kept RELATIVE to the home. At 390×610−80 band that is pixel-identical to
 *    the mockup, and on any other size an exit still leaves the screen.
 *  - **Mimetismo's eyes**: the mockup hard-codes `#e8eaed`, invisible on the
 *    light appearance. The fade colour is an INPUT (`SceneContext.eyeFade`),
 *    because the phone must read on both grounds.
 *
 * The bitmap and the nine tone tables are COPIES of the TUI's, not imports: the
 * phone's bundle must not reach `@tentacle/tui` (it pulls `chalk`).
 * `mascot-parity.test.ts` reads both sources and fails if these drift.
 */

/** The owner's drawing, verbatim (`packages/tui/src/mascot.ts` `MASCOT_BITMAP`). */
export const MASCOT_BITMAP: readonly string[] = [
  "..KKKKK..",
  ".KSFFFSK.",
  "KSFFFFFSK",
  "KFEFFFEFK",
  "KFEFFFEFK",
  "KBBFSFBBK",
  ".KFFFFFK.",
  "KSSKSKSSK",
  ".KK.K.KK.",
  ".........",
];

/** The nine palettes, in the TUI's order (`packages/tui/src/theme.ts` `MASCOT.tones`). */
export const PALETTE_NAMES = [
  "soft",
  "logo",
  "glow",
  "cyan",
  "teal",
  "coral",
  "mint",
  "amber",
  "sky",
] as const;

export type MascotPaletteName = (typeof PALETTE_NAMES)[number];

/** One palette's five tones (`K` outline, `E` eyes, `F` body, `S` shade, `B` blush). */
export type MascotTone = Readonly<Record<"K" | "E" | "F" | "S" | "B", string>>;

export const MASCOT_PALETTES: Readonly<Record<MascotPaletteName, MascotTone>> = {
  soft: { K: "#7B3FC0", E: "#3E1A5E", F: "#B387EA", S: "#A274DE", B: "#DDBFF8" },
  logo: { K: "#6E36AE", E: "#3E1A5E", F: "#A267DB", S: "#9258CF", B: "#CFA8F3" },
  glow: { K: "#C9A6F2", E: "#3E1A5E", F: "#8E4BC4", S: "#8143B8", B: "#B583E0" },
  cyan: { K: "#0E8AA8", E: "#083A47", F: "#5FE0F2", S: "#3FCFE6", B: "#B7F3FB" },
  teal: { K: "#14857A", E: "#0A3B36", F: "#5CD6C4", S: "#40C2AF", B: "#B5EEE4" },
  coral: { K: "#C2475A", E: "#5A1622", F: "#F58C93", S: "#EC7480", B: "#FFC6C2" },
  mint: { K: "#3C9A5C", E: "#163D24", F: "#8FE0A6", S: "#73D28E", B: "#CFF5D9" },
  amber: { K: "#B7791F", E: "#4A2E07", F: "#F7C35C", S: "#EEB043", B: "#FFE3A8" },
  sky: { K: "#3A6FD0", E: "#13285A", F: "#8DB4F7", S: "#73A0F0", B: "#CFE0FF" },
};

/**
 * The props' own colours — the mockup's `EXTRA` table, verbatim: the canopy and
 * the strings, the board, the rocket, the UFO, the balloon, the flames, the dust
 * and the helicopter. Not a palette: a scene's vehicle is the same in all nine.
 */
export const EXTRA_TONES: Readonly<Record<string, string>> = {
  C: "#E6E9EC",
  L: "#8d969e",
  T: "#B98B5B",
  W: "#E8EAED",
  Q: "#9fdcea",
  H: "#cfe3ea",
  G: "#ffffff",
  A: "#F7B23C",
  Y: "#FFF1C9",
  N: "#3d3550",
  M: "#544a6b",
  R: "#E5677A",
};

/** One pixel of Polpetto, in points (owner decision 1: 6 pt, so the sprite is 54 pt). */
export const PIXEL_PT = 6;

/** The sprite's side in pixels, and in points. */
export const SPRITE_PX = 9;
export const SPRITE_PT = PIXEL_PT * SPRITE_PX;

/** The mockup's home, in grid units — the anchor every scene's op is relative to. */
export const HOME_GRID = { x: 28, y: 80 } as const;

/** The sprite's bottom edge sits this far above the band's bottom (610 − 534 in the mockup). */
export const HOME_INSET_PT = 76;

/** The layer's measured box: the band between the screen header and the composer. */
export interface MascotGeometry {
  readonly width: number;
  readonly height: number;
}

/** Where the home's top-left corner goes, in points: centred, `HOME_INSET_PT` above the bottom. */
export function homeAt(geometry: MascotGeometry): { readonly x: number; readonly y: number } {
  return {
    x: (geometry.width - SPRITE_PT) / 2,
    // A band shorter than the sprite keeps the home at its top rather than off it.
    y: Math.max(0, geometry.height - HOME_INSET_PT - SPRITE_PT),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Draw ops, in grid units
 * ---------------------------------------------------------------------------
 */

/** A run of sprite rows: `.` is empty, any other char is a colour key of `map`. */
export interface SpriteOp {
  readonly kind: "sprite";
  readonly rows: readonly string[];
  readonly x: number;
  readonly y: number;
  /** 1 unless the op is fading. */
  readonly alpha?: number;
  /** Colours to override for this op only (Mimetismo's palette switch). */
  readonly map?: Readonly<Record<string, string>>;
}

/** A filled rectangle of one colour key of the base map (the UFO's beam, a bubble). */
export interface RectOp {
  readonly kind: "rect";
  readonly rect: readonly [number, number, number, number];
  readonly color: string;
  readonly alpha?: number;
}

export type Op = SpriteOp | RectOp;

const sprite = (
  rows: readonly string[],
  x: number,
  y: number,
  extra: { readonly alpha?: number; readonly map?: Readonly<Record<string, string>> } = {},
): SpriteOp => ({ kind: "sprite", rows, x, y, ...extra });

const rect = (
  r: readonly [number, number, number, number],
  color: string,
  alpha: number,
): RectOp => ({ kind: "rect", rect: r, color, alpha });

/*
 * ---------------------------------------------------------------------------
 * The mockup's own maths, verbatim
 * ---------------------------------------------------------------------------
 */

const ease = {
  out: (p: number): number => 1 - (1 - p) ** 3,
  in: (p: number): number => p ** 3,
  io: (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
};

const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const seg = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));

/** Blinking is a 150 ms shut at each named moment. */
const BLINK_S = 0.15;
const blinkAt = (t: number, ...at: readonly number[]): boolean =>
  at.some((a) => t >= a && t < a + BLINK_S);

/*
 * ---------------------------------------------------------------------------
 * Polpetto's frames
 * ---------------------------------------------------------------------------
 */

export type MascotEyes = "open" | "closed" | "left" | "right" | "up";

export interface BodyOptions {
  readonly eyes?: MascotEyes;
  readonly legs?: 0 | 1 | 2;
  readonly squash?: boolean;
}

/** The drawing in one pose — the mockup's `body()`, verbatim. */
export function body(options: BodyOptions = {}): readonly string[] {
  const eyes = options.eyes ?? "open";
  const legs = options.legs ?? 0;
  // The trailing all-empty row of the shared bitmap carries no pixel.
  const rows: string[] = MASCOT_BITMAP.slice(0, SPRITE_PX);
  if (eyes === "closed") rows[3] = "KFFFFFFFK";
  if (eyes === "left") {
    rows[3] = "KEFFFEFFK";
    rows[4] = "KEFFFEFFK";
  }
  if (eyes === "right") {
    rows[3] = "KFFEFFFEK";
    rows[4] = "KFFEFFFEK";
  }
  if (eyes === "up") rows[4] = "KFFFFFFFK";
  if (legs === 1) rows[8] = "KK..K..KK";
  if (legs === 2) {
    rows[7] = ".KSKSKSK.";
    rows[8] = ".K.K.K.K.";
  }
  return options.squash === true ? [".........", ...rows.slice(0, 8)] : rows;
}

const CANOPY = [
  "....CCCCC....",
  "..CCSSCSSCC..",
  ".CSSCCCCCSSC.",
  "CCCCCCCCCCCCC",
  "L.....L.....L",
  ".L....L....L.",
  "..L...L...L..",
  "..L...L...L..",
];

const CANOPY_FALLING = CANOPY.slice(0, 4);

const BOARD = ["T.........T", ".TTTTTTTTT.", "..W.....W.."];

const ROCKET = [
  "......K......",
  ".....KKK.....",
  "....KKKKK....",
  "....CCCCC....",
  "...CCCCCCC...",
  "...CCCCCCC...",
  "...CCQQQCC...",
  "...CQQQQQC...",
  "...CQQQQQC...",
  "...CCQQQCC...",
  "...CCCCCCC...",
  "...CCCCCCC...",
  "...CKKKKKC...",
  "...CCCCCCC...",
  "...CCCCCCC...",
  "..KCCCCCCCK..",
  ".KKCCCCCCCKK.",
  "KKKCCCCCCCKKK",
  "KKK.CCCCC.KKK",
  "KK...KKK...KK",
];

/** The rocket with Polpetto's face at the window (rows 6–9). */
const ROCKET_IN: readonly string[] = ROCKET.map(
  (row, i) =>
    ({
      6: "...CCFFFCC...",
      7: "...CFEFEFC...",
      8: "...CFFFFFC...",
      9: "...CCFFFCC...",
    })[i] ?? row,
);

const FLAME: readonly (readonly string[])[] = [
  ["....AAAAA....", ".....AYA.....", ".....AYA.....", "......A......", "......A......"],
  ["....AYAYA....", "....AAAAA....", ".....AAA.....", "......A......"],
];

const FLAME_SMALL = [".....AYA.....", "......A......"];

const UFO0 = [
  "....HHHHHHH....",
  "...HGGHHHHHH...",
  "..HGHHHHHHHHH..",
  ".LLLLLLLLLLLLL.",
  "LCYCCYCCYCCYCCL",
  ".LLLLLLLLLLLLL.",
  "...LL.....LL...",
];

/** The UFO's second frame: the lights move along the rim. */
const UFO1 = UFO0.map((row, i) => (i === 4 ? "LCCYCCYCCYCCYCL" : row));

const BALLOON = [
  "..RRRRR..",
  ".RGGRRRR.",
  "RGGRRRRRR",
  "RGRRRRRRR",
  "RRRRRRRRR",
  "RRRRRRRRR",
  "RRRRRRRRR",
  ".RRRRRRR.",
  "..RRRRR..",
  "...RRR...",
  "....R....",
];

/** Pad every row of a sprite to its widest, so a canvas row is a full rectangle. */
const padRows = (rows: readonly string[]): readonly string[] => {
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(width, "."));
};

/** The rotor's other frame: the blades shorten toward the middle. */
const rotorB = (row: string): string => {
  const first = row.indexOf("T");
  const last = row.lastIndexOf("T");
  const quarter = Math.round((last - first) / 4);
  return [...row]
    .map((char, i) => (char === "T" && (i < first + quarter || i > last - quarter) ? "." : char))
    .join("");
};

/**
 * A utility helicopter (owner decision 2, mockup *style B*): bubble cabin, a door
 * with a porthole, a tail boom — 12 rows, 29 px wide.
 */
const HELI_B = padRows([
  "....TTTTTTTTTTTTTTTTTT",
  "............K",
  "..........KKKK",
  "....KKKKKKSSSSKK............KK",
  "...KHHHHKSSSSSSSK..........KSK",
  "..KHHGHHKSKKKSSSSKKKKKKKKKKKSK",
  "..KHHHHHKSKQKSSSSSSSSSSSSSSKK",
  ".KFFFFFFKSKQKSSSKKKKKKKKKKK",
  ".KFAFFAFKSKKKSSK",
  "..KKKKKKKKKKKKKK",
  "....L.......L",
  "..LLLLLLLLLLLLLL",
]);

/** The same, with Polpetto's face in the windscreen (rows 5–6, columns 2–9). */
const HELI_B_IN: readonly string[] = HELI_B.map((row, i) =>
  i === 5 ? "..KFEFEFK".concat(row.slice(9)) : i === 6 ? "..KFFFFFK".concat(row.slice(9)) : row,
);

/*
 * ---------------------------------------------------------------------------
 * The nine scenes
 * ---------------------------------------------------------------------------
 */

export type MascotSceneKey =
  | "para"
  | "skate"
  | "peek"
  | "swim"
  | "rocket"
  | "ufo"
  | "camo"
  | "balloon"
  | "heli";

/** What a scene may read beyond the clock and the run counter. */
export interface SceneContext {
  /** Mimetismo's leftover eyes: a colour that reads on this appearance. */
  readonly eyeFade: string;
}

/** The mockup's own eye colour, for a caller with no appearance to hand. */
export const DEFAULT_EYE_FADE = EXTRA_TONES.W ?? "#E8EAED";

export interface MascotScene {
  readonly key: MascotSceneKey;
  /** The owner's name for it (Italian, as in the mockup). */
  readonly name: string;
  /** The mockup's one-line story, kept as the scene's own documentation. */
  readonly story: string;
  readonly durationMs: number;
  /**
   * True for the two scenes that start BEHIND the composer (peek, swim): the
   * layer clips them, so they emerge from its bottom edge.
   */
  readonly behind: boolean;
  /** The mockup's `frame(t)`: `t` in SECONDS, ops in grid units. */
  readonly frame: (t: number, run: number, ctx: SceneContext) => readonly Op[];
}

/** Paracadute: down from the top under a canopy, a 1-px squash, then walks off. */
const para: MascotScene = {
  key: "para",
  name: "Paracadute",
  story:
    "Scende piano dall'alto ondeggiando, atterra con un piccolo schiacciamento, il paracadute cade. Sbatte le palpebre, guarda di lato e se ne va camminando.",
  durationMs: 10_600,
  behind: false,
  frame: (t, run) => {
    const dir = run % 2 === 1 ? -1 : 1;
    if (t < 3.2) {
      const p = ease.out(t / 3.2);
      const x = HOME_GRID.x + Math.round(2 * Math.sin(t * 3.9)) * (1 - p) ** 0.5;
      const y = lerp(-10, HOME_GRID.y, p);
      return [sprite(CANOPY, x - 2, y - 8), sprite(body(), x, y)];
    }
    const fall = seg(t, 3.2, 3.9);
    const ops: Op[] = [];
    if (fall < 1) {
      ops.push(
        sprite(
          CANOPY_FALLING,
          HOME_GRID.x - 2 + dir * -Math.round(fall * 4),
          HOME_GRID.y - 8 + Math.round(fall * 9),
          { alpha: 1 - fall },
        ),
      );
    }
    if (t < 3.4) {
      return [...ops, sprite(body({ squash: true }), HOME_GRID.x, HOME_GRID.y)];
    }
    if (t < 6.0) {
      const eyes: MascotEyes = blinkAt(t, 4.5)
        ? "closed"
        : t > 5.3
          ? dir > 0
            ? "right"
            : "left"
          : "open";
      return [...ops, sprite(body({ eyes }), HOME_GRID.x, HOME_GRID.y)];
    }
    const step = Math.floor((t - 6.0) / 0.11);
    return [
      sprite(
        body({ eyes: dir > 0 ? "right" : "left", legs: (Math.floor(step / 2) % 2) as 0 | 1 | 2 }),
        HOME_GRID.x + dir * step,
        HOME_GRID.y,
      ),
    ];
  },
};

/** Skateboard: in from the left, brake, look around, a hop, out to the right faster. */
const skate: MascotScene = {
  key: "skate",
  name: "Skateboard",
  story:
    "Entra da sinistra sullo skate e frena al centro. Si guarda intorno, fa un saltello e riparte veloce, uscendo a destra.",
  durationMs: 6_800,
  behind: false,
  frame: (t) => {
    let x: number;
    let y = HOME_GRID.y;
    let eyes: MascotEyes = "open";
    if (t < 1.8) {
      x = Math.round(lerp(-13, HOME_GRID.x, ease.out(t / 1.8)));
    } else if (t < 4.6) {
      x = HOME_GRID.x;
      eyes = blinkAt(t, 2.9) ? "closed" : t > 3.7 ? "right" : t > 3.2 ? "left" : "open";
    } else if (t < 4.85) {
      x = HOME_GRID.x;
      y = HOME_GRID.y - 1;
      eyes = "right";
    } else {
      x = Math.round(lerp(HOME_GRID.x, 68, ease.in(seg(t, 4.85, 6.3))));
      eyes = "right";
    }
    const boardY = t >= 4.6 && t < 4.85 ? HOME_GRID.y - 1 : HOME_GRID.y;
    return [sprite(BOARD, x - 1, boardY + 8), sprite(body({ eyes }), x, y)];
  },
};

/** Sbuca dal campo: up from behind the composer, looks both ways, waves, sinks back. */
const peek: MascotScene = {
  key: "peek",
  name: "Sbuca dal campo",
  story:
    "Spunta da dietro il campo di scrittura, guarda a sinistra e a destra, saluta con un tentacolo e torna giù.",
  durationMs: 5_800,
  behind: true,
  frame: (t) => {
    const up = 96;
    const down = 103;
    const y =
      t < 0.7
        ? Math.round(lerp(down, up, ease.out(t / 0.7)))
        : t < 4.6
          ? up
          : Math.round(lerp(up, down, ease.in(seg(t, 4.6, 5.2))));
    const eyes: MascotEyes =
      t > 1.0 && t < 1.6
        ? "left"
        : t > 1.6 && t < 2.2
          ? "right"
          : blinkAt(t, 2.6)
            ? "closed"
            : "open";
    const ops: Op[] = [sprite(body({ eyes }), HOME_GRID.x, y)];
    if (t > 3.0 && t < 4.3) {
      const wave = Math.floor((t - 3.0) / 0.22) % 2;
      ops.push(sprite(wave === 1 ? [".K", "K."] : ["..", "KK"], HOME_GRID.x + 9, y + 2));
    }
    return ops;
  },
};

/** Nuota: in from the bottom-left in tentacle pulses, hovers bobbing, out to the top-right. */
const swim: MascotScene = {
  key: "swim",
  name: "Nuota",
  story:
    "Arriva nuotando dal basso a sinistra a colpi di tentacoli, con qualche bolla. Galleggia un momento al centro e riparte in alto a destra.",
  durationMs: 8_600,
  behind: true,
  frame: (t) => {
    const inPath: readonly (readonly [number, number])[] = [
      [-12, 112],
      [HOME_GRID.x, HOME_GRID.y],
    ];
    const outPath: readonly (readonly [number, number])[] = [
      [HOME_GRID.x, HOME_GRID.y],
      [70, -14],
    ];
    const stride = 0.7;
    const swimStep = (
      t0: number,
      path: readonly (readonly [number, number])[],
    ): { x: number; y: number; legs: 0 | 2 } => {
      const k = Math.min(3, Math.floor((t - t0) / stride));
      const tp = (t - t0 - k * stride) / stride;
      const p = (k + ease.out(clamp(tp / 0.4))) / 4;
      const from = path[0] ?? [0, 0];
      const to = path[1] ?? [0, 0];
      return {
        x: Math.round(lerp(from[0], to[0], p)),
        y: Math.round(lerp(from[1], to[1], p)),
        legs: tp < 0.4 ? 0 : 2,
      };
    };
    const ops: Op[] = [];
    let s: { x: number; y: number; legs: 0 | 2; eyes?: MascotEyes };
    if (t < 2.8) {
      s = swimStep(0, inPath);
    } else if (t < 5.4) {
      s = {
        x: HOME_GRID.x,
        y: HOME_GRID.y + (Math.floor((t - 2.8) / 0.6) % 2),
        legs: 0,
        eyes: blinkAt(t, 4.0) ? "closed" : "open",
      };
    } else {
      s = { ...swimStep(5.4, outPath), eyes: "right" };
    }
    const puffLife = 1.2;
    for (const p0 of [0, 0.7, 1.4, 2.1, 5.4, 6.1, 6.8, 7.5]) {
      const age = t - p0;
      if (age < 0 || age > puffLife) {
        continue;
      }
      const src =
        p0 < 2.8
          ? { x: lerp(-12, HOME_GRID.x, p0 / 2.8), y: lerp(112, HOME_GRID.y, p0 / 2.8) }
          : {
              x: lerp(HOME_GRID.x, 70, (p0 - 5.4) / 2.8),
              y: lerp(HOME_GRID.y, -14, (p0 - 5.4) / 2.8),
            };
      ops.push(
        sprite(["Q"], Math.round(src.x + 3 + Math.sin(age * 6)), Math.round(src.y + 9 - age * 9), {
          alpha: 1 - age / puffLife,
        }),
      );
    }
    ops.push(sprite(body({ eyes: s.eyes ?? "open", legs: s.legs }), s.x, s.y));
    return ops;
  },
};

/** Razzo: walks in, hops into a 13×20 rocket, his face at the window, launches. No helmet. */
const rocket: MascotScene = {
  key: "rocket",
  name: "Razzo",
  story:
    "Entra camminando, guarda il razzo e ci salta dentro: dal finestrino spunta la sua faccina. Il razzo trema, si accende e parte verso l'alto uscendo dallo schermo, lasciando un po' di fumo.",
  durationMs: 7_400,
  behind: false,
  frame: (t) => {
    const RX = 40;
    const RY = 69;
    const ops: Op[] = [];
    let rx = RX;
    let ry = RY;
    let inside = false;
    let flame: readonly string[] | null = null;
    if (t < 2.0) {
      const step = Math.floor(t / 0.06);
      ops.push(
        sprite(
          body({ eyes: "right", legs: (Math.floor(step / 2) % 2) as 0 | 1 | 2 }),
          Math.min(22, -10 + step),
          HOME_GRID.y,
        ),
      );
    } else if (t < 3.0) {
      ops.push(sprite(body({ eyes: blinkAt(t, 2.5) ? "closed" : "right" }), 22, HOME_GRID.y));
    } else if (t < 3.8) {
      const p = seg(t, 3.0, 3.8);
      ops.push(
        sprite(
          body({ eyes: "right" }),
          Math.round(lerp(22, RX + 2, p)),
          Math.round(HOME_GRID.y - Math.sin(p * Math.PI) * 8),
        ),
      );
    } else {
      inside = true;
    }
    if (t >= 3.8 && t < 4.8) {
      rx = RX + (Math.floor(t / 0.07) % 2);
      flame = FLAME_SMALL;
    }
    if (t >= 4.8) {
      ry = Math.round(lerp(RY, -34, ease.in(seg(t, 4.8, 6.8))));
      flame = FLAME[Math.floor(t / 0.08) % 2] ?? FLAME_SMALL;
    }
    ops.push(sprite(inside ? ROCKET_IN : ROCKET, rx, ry));
    if (flame !== null) {
      ops.push(sprite(flame, rx, ry + 20));
    }
    if (t >= 4.8) {
      const age = t - 4.8;
      const fade = Math.max(0, 1 - age / 2.4) * 0.7;
      for (const d of [-1, 0, 1]) {
        ops.push(
          sprite(
            ["LLL", "LLL"],
            RX + 5 + d * Math.round(age * 6),
            RY + 19 - Math.round(age * (d === 0 ? 2.5 : 1)),
            { alpha: fade },
          ),
        );
      }
    }
    return ops;
  },
};

/** UFO: a saucer parks above him, a beam widens, he dematerialises feet first, it leaves. */
const ufo: MascotScene = {
  key: "ufo",
  name: "UFO",
  story:
    "Polpetto è al suo posto. In alto arriva un UFO che si ferma sopra di lui: Polpetto si accorge, il raggio di luce lo smaterializza riga per riga e l'UFO se ne va con il bottino.",
  durationMs: 6_200,
  behind: false,
  frame: (t) => {
    const ops: Op[] = [];
    const cx = HOME_GRID.x + 4;
    const UY = 22;
    const parked = HOME_GRID.x + 4 - 7;
    let ux: number;
    let uy = UY + (Math.floor(t / 0.5) % 2);
    if (t < 2.2) {
      ux = Math.round(lerp(-17, parked, ease.out(t / 2.2)));
    } else if (t < 4.4) {
      ux = parked;
      uy = t > 4.1 ? UY - 1 : uy;
    } else {
      const p = ease.in(seg(t, 4.4, 5.8));
      ux = Math.round(lerp(parked, 70, p));
      uy = Math.round(lerp(UY - 1, 4, p));
    }
    // The beam: grows down 2.4–2.8, holds, retracts up 3.7–4.1.
    const top = UY + 7;
    const bottom = HOME_GRID.y + 9;
    let beamTop = top;
    let beamBottom = top;
    if (t >= 2.4 && t < 2.8) {
      beamBottom = Math.round(lerp(top, bottom, seg(t, 2.4, 2.8)));
    } else if (t >= 2.8 && t < 3.7) {
      beamBottom = bottom;
    } else if (t >= 3.7 && t < 4.1) {
      beamBottom = bottom;
      beamTop = Math.round(lerp(top, bottom, seg(t, 3.7, 4.1)));
    }
    for (let row = beamTop; row < beamBottom; row++) {
      const width = Math.min(13, 5 + Math.floor((row - top) / 5));
      ops.push(rect([cx - Math.floor(width / 2), row, width, 1], "Q", 0.24));
    }
    // Polpetto: there from the start; notices at 1.6; dematerialises 2.9–3.8.
    if (t < 3.8) {
      const eyes: MascotEyes = blinkAt(t, 0.8) ? "closed" : t > 1.4 && t < 2.2 ? "left" : "open";
      const gone = t < 2.9 ? 0 : Math.floor((t - 2.9) / 0.1);
      const rows = body({ eyes }).map((row, i) => (i >= 9 - gone ? "........." : row));
      ops.push(sprite(rows, HOME_GRID.x, HOME_GRID.y));
      if (t > 2.0 && t < 2.7) {
        ops.push(sprite(["Y", "Y", ".", "Y"], cx, HOME_GRID.y - 6));
      }
    }
    if (t > 2.9 && t < 4.0) {
      for (let k = 0; k < 5; k++) {
        const phase = ((t - 2.9) * 1.4 + k / 5) % 1;
        ops.push(
          sprite(["Y"], cx - 3 + ((k * 3) % 7), Math.round(lerp(HOME_GRID.y + 4, top, phase)), {
            alpha: 0.9,
          }),
        );
      }
    }
    ops.push(sprite(Math.floor(t / 0.15) % 2 === 1 ? UFO1 : UFO0, ux, uy));
    return ops;
  },
};

/** Mimetismo: faster and faster palette switches, then invisible but for the eyes. */
const camo: MascotScene = {
  key: "camo",
  name: "Mimetismo",
  story:
    "Cambia colore sempre più in fretta, poi prende il colore dello sfondo e diventa invisibile. Restano solo gli occhi, che sbattono e spariscono.",
  durationMs: 5_400,
  behind: false,
  frame: (t, run, ctx) => {
    if (t < 1.0) {
      const eyes: MascotEyes = blinkAt(t, 0.5) ? "closed" : "open";
      return [sprite(body({ eyes }), HOME_GRID.x, HOME_GRID.y)];
    }
    if (t < 3.0) {
      // Switch times, gap by gap: eight switches in two seconds, faster and faster.
      const times = [1.0, 1.5, 1.9, 2.2, 2.45, 2.65, 2.8, 2.92];
      let i = 0;
      while (i < times.length - 1 && t >= (times[i + 1] ?? Number.POSITIVE_INFINITY)) {
        i++;
      }
      const name = PALETTE_NAMES[(i + run * 3 + 1) % PALETTE_NAMES.length] ?? "soft";
      return [
        sprite(body(), HOME_GRID.x, HOME_GRID.y, {
          map: { ...MASCOT_PALETTES[name], ...EXTRA_TONES },
        }),
      ];
    }
    if (t < 4.0) {
      return [sprite(body(), HOME_GRID.x, HOME_GRID.y, { alpha: 1 - seg(t, 3.0, 4.0) })];
    }
    if (t < 5.0 && !blinkAt(t, 4.5)) {
      // Only the eyes are left, in the appearance's own light colour.
      const eyes = body().map((row) => row.replace(/[^E]/g, "."));
      return [sprite(eyes, HOME_GRID.x, HOME_GRID.y, { map: { E: ctx.eyeFade } })];
    }
    return [];
  },
};

/** Palloncino: in holding a 9×11 balloon, looks up, and it lifts him off the top. */
const balloon: MascotScene = {
  key: "balloon",
  name: "Palloncino",
  story:
    "Entra camminando con un palloncino legato a un tentacolo. Si ferma, guarda in su, e il palloncino lo solleva e lo porta via in alto.",
  durationMs: 6_600,
  behind: false,
  frame: (t) => {
    let px: number;
    // `HOME_GRID` is `as const`: its `y` is the literal 80, so the track is a number.
    let py: number = HOME_GRID.y;
    let legs: 0 | 1 | 2 = 0;
    let eyes: MascotEyes = "right";
    if (t < 2.0) {
      const step = Math.floor(t / 0.05);
      px = Math.min(HOME_GRID.x, -12 + step);
      legs = (Math.floor(step / 2) % 2) as 0 | 1 | 2;
    } else if (t < 3.4) {
      px = HOME_GRID.x;
      eyes = blinkAt(t, 2.5) ? "closed" : t > 2.8 ? "up" : "open";
      py = t > 3.1 ? HOME_GRID.y - 1 : HOME_GRID.y;
    } else {
      px = HOME_GRID.x + Math.round(Math.sin((t - 3.4) * 3));
      py = Math.round(lerp(HOME_GRID.y - 1, -34, ease.in(seg(t, 3.4, 6.2))));
      legs = Math.floor(t / 0.18) % 2 === 1 ? 2 : 0;
      eyes = "up";
    }
    const bob = Math.floor(t / 0.6) % 2;
    const ops: Op[] = [sprite(body({ eyes, legs }), px, py), sprite(["K"], px + 9, py + 4)];
    for (let y = py - 6 - bob; y <= py + 3; y++) {
      ops.push(sprite(["L"], px + 9, y));
    }
    ops.push(sprite(BALLOON, px + 5, py - 17 - bob));
    return ops;
  },
};

/** Elicottero (style B): down with his face at the windscreen, dust, he hops out, it goes. */
const heli: MascotScene = {
  key: "heli",
  name: "Elicottero",
  story:
    "Dall'alto scende un elicottero (cabina a bolla, porta con oblò) con Polpetto al vetro. Atterra alzando polvere, lui salta giù, l'elicottero riparte verso l'alto e lui se ne va camminando.",
  durationMs: 9_600,
  behind: false,
  frame: (t) => {
    const HX = 30;
    const HY = 77;
    const rotor = rotorB(HELI_B[0] ?? "");
    const ops: Op[] = [];
    let hx = HX;
    let hy = HY;
    const inside = t < 3.0;
    if (t < 2.6) {
      hy = Math.round(lerp(-15, HY, ease.out(t / 2.6)));
      hx = HX + Math.round(Math.sin(t * 2.5) * (1 - t / 2.6));
    } else if (t >= 4.4) {
      const p = ease.in(seg(t, 4.4, 6.2));
      hy = Math.round(lerp(HY, -16, p));
      hx = Math.round(lerp(HX, 58, p));
    }
    if (t >= 3.0 && t < 3.6) {
      const p = seg(t, 3.0, 3.6);
      ops.push(
        sprite(
          body({ eyes: "left" }),
          Math.round(lerp(33, 18, p)),
          Math.round(HOME_GRID.y - Math.sin(p * Math.PI) * 5),
        ),
      );
    } else if (t >= 3.6 && t < 6.4) {
      const eyes: MascotEyes =
        blinkAt(t, 4.0) || blinkAt(t, 5.9) ? "closed" : t >= 4.6 ? "up" : "right";
      ops.push(sprite(body({ eyes }), 18, HOME_GRID.y));
    } else if (t >= 6.4) {
      const step = Math.floor((t - 6.4) / 0.1);
      ops.push(
        sprite(
          body({ eyes: "left", legs: (Math.floor(step / 2) % 2) as 0 | 1 | 2 }),
          18 - step,
          HOME_GRID.y,
        ),
      );
    }
    // The dust of the landing and of the take-off.
    for (const t0 of [2.4, 4.4]) {
      const age = t - t0;
      if (age < 0 || age > 0.7) {
        continue;
      }
      for (const d of [-1, 1]) {
        ops.push(
          sprite(["LL"], HX + 9 + d * Math.round(9 + age * 10), HY + 11 - Math.round(age * 2), {
            alpha: (1 - age / 0.7) * 0.7,
          }),
        );
      }
    }
    if (hy > -16) {
      const rows = [...(inside ? HELI_B_IN : HELI_B)];
      if (Math.floor(t / 0.06) % 2 === 1) {
        rows[0] = rotor;
      }
      ops.push(sprite(rows, hx, hy));
    }
    return ops;
  },
};

/** The nine, in the mockup's order (the order `pickScene` walks). */
export const MASCOT_SCENES: readonly MascotScene[] = [
  para,
  skate,
  peek,
  swim,
  rocket,
  ufo,
  camo,
  balloon,
  heli,
];

/** The scene for a key. Exhaustive over `MascotSceneKey`, so a caller never probes. */
export function sceneByKey(key: MascotSceneKey): MascotScene {
  const found = MASCOT_SCENES.find((scene) => scene.key === key);
  // Unreachable: `MascotSceneKey` is exactly the nine keys above.
  if (found === undefined) {
    throw new Error(`unknown mascot scene ${key}`);
  }
  return found;
}

/**
 * One scene's ops at `tMs` after it started, in grid units. Nothing is drawn once
 * the scene is over (owner decision 4: it plays ONCE) — the end is exclusive.
 * `run` alternates the two handednesses (Paracadute walks off left or right).
 */
export function frameAt(
  scene: MascotScene,
  tMs: number,
  run = 0,
  ctx: SceneContext = { eyeFade: DEFAULT_EYE_FADE },
): readonly Op[] {
  if (!(tMs < scene.durationMs)) {
    return [];
  }
  return scene.frame(Math.max(0, tMs) / 1000, run, ctx);
}

/**
 * Do two frames draw the same picture? Compared by CONTENT (a scene builds its
 * arrays anew each frame), so the layer redraws only on a real change
 * (docs/feat/mobile-ui-fluidity-s7.md).
 */
export function sameFrame(a: readonly Op[], b: readonly Op[]): boolean {
  return (
    a.length === b.length &&
    a.every((op, i) => {
      const other = b[i];
      return other !== undefined && sameOp(op, other);
    })
  );
}

function sameOp(a: Op, b: Op): boolean {
  if (a.alpha !== b.alpha) {
    return false;
  }
  if (a.kind === "rect") {
    return b.kind === "rect" && a.color === b.color && a.rect.every((v, i) => v === b.rect[i]);
  }
  return (
    b.kind === "sprite" &&
    a.x === b.x &&
    a.y === b.y &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => row === b.rows[i]) &&
    sameMap(a.map, b.map)
  );
}

function sameMap(a: SpriteOp["map"], b: SpriteOp["map"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Reduce Motion (owner decision 6): Polpetto stands still at home, eyes open. */
export function stillFrame(): readonly Op[] {
  return [sprite(body({ eyes: "open" }), HOME_GRID.x, HOME_GRID.y)];
}

/**
 * Whether the mascot's layer belongs on this session (owner decisions 4 and 5):
 * an OPEN session with no rows at all. The first message — or any transcript
 * item — makes this false at once, and the layer unmounts mid-scene.
 */
export function showsScene(view: {
  readonly phase: string;
  readonly rowCount: number;
}): boolean {
  return view.phase === "open" && view.rowCount === 0;
}

/*
 * ---------------------------------------------------------------------------
 * Grid → points: the only projection, so a scene's numbers stay the mockup's
 * ---------------------------------------------------------------------------
 */

/** One filled rectangle on the layer, in points. */
export interface Pixel {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly alpha: number;
}

/**
 * A rect's React key. Computed HERE, not in the component (AGENTS §7): the
 * property is "two rects are two", a decision with a failure mode a source
 * regex cannot see. The index is what tells apart two rects that are identical
 * in place, size, colour and alpha — the rocket's three stacked puffs — so it
 * belongs in the key, and the frame's list is rebuilt every tick anyway.
 * Takes `(rect, index)` so a caller writes `rects.map(rectKey)`.
 */
export function rectKey(rect: Pixel, index: number): string {
  return `${index}:${rect.x}:${rect.y}:${rect.w}:${rect.h}:${rect.color}`;
}

/** The colours a glyph may resolve to: a palette's five tones plus the props' own. */
export function colorsFor(palette: MascotPaletteName): Readonly<Record<string, string>> {
  return { ...MASCOT_PALETTES[palette], ...EXTRA_TONES };
}

/**
 * The rects a frame draws, in points: the pixel grid at `PIXEL_PT`, anchored on
 * `homeAt(geometry)`, with each row's equal-coloured neighbours merged into one
 * run and, WITHIN ONE OP, vertically contiguous rects of the same colour merged
 * into one block (a 9×9 sprite is ≤ 81 pixels; a frame here stays under ~120
 * rects, and the UFO's 60-row beam collapses to a dozen). Ops are emitted in
 * order and never merged with each other: that order is the painter's order, so
 * a later op keeps painting over an earlier one.
 */
export function pixels(
  ops: readonly Op[],
  geometry: MascotGeometry,
  colors: Readonly<Record<string, string>>,
): readonly Pixel[] {
  const home = homeAt(geometry);
  const at = (gx: number, gy: number): { x: number; y: number } => ({
    x: home.x + (gx - HOME_GRID.x) * PIXEL_PT,
    y: home.y + (gy - HOME_GRID.y) * PIXEL_PT,
  });
  const out: Pixel[] = [];
  for (const op of ops) {
    const alpha = op.alpha ?? 1;
    if (alpha <= 0) {
      continue;
    }
    // One op's rects, merged among THEMSELVES only (see `mergeDown`): a sprite's
    // own rects never overlap each other, so merging them cannot disturb the
    // painter's order — and that order is the mockup's z-order (the helicopter's
    // body over its windscreen, the smoke over the rocket). Merging ACROSS ops
    // would: a later op must paint over an earlier one.
    const flat: Pixel[] = [];
    if (op.kind === "rect") {
      const [gx, gy, gw, gh] = op.rect;
      const color = colors[op.color];
      if (color === undefined) {
        continue;
      }
      const { x, y } = at(gx, gy);
      appendBlock(out, [{ x, y, w: gw * PIXEL_PT, h: gh * PIXEL_PT, color, alpha }]);
      continue;
    }
    const map = op.map === undefined ? colors : { ...colors, ...op.map };
    op.rows.forEach((row, i) => {
      const { x, y } = at(op.x, op.y + i);
      let runStart = -1;
      let runColor: string | undefined;
      const flush = (endCol: number): void => {
        if (runStart >= 0 && runColor !== undefined) {
          flat.push({
            x: x + runStart * PIXEL_PT,
            y,
            w: (endCol - runStart) * PIXEL_PT,
            h: PIXEL_PT,
            color: runColor,
            alpha,
          });
        }
        runStart = -1;
        runColor = undefined;
      };
      [...row].forEach((char, col) => {
        const color = char === "." ? undefined : map[char];
        if (color === undefined) {
          flush(col);
          return;
        }
        if (color !== runColor) {
          flush(col);
          runStart = col;
          runColor = color;
        }
      });
      flush(row.length);
    });
    appendBlock(out, mergeDown(flat));
  }
  return out;
}

/**
 * Append one op's merged rects, extending the LAST rect already emitted when the
 * two are the same shape, colour and alpha and STRICTLY contiguous below it
 * (`rect.y === last.y + last.h`). Safe for the painter's order: nothing was
 * emitted between them, so the two are consecutive strokes of one colour — the
 * UFO's beam is 60 one-row `rect` ops and still collapses to a dozen blocks,
 * while an op drawn OVER another (the helicopter's body over its windscreen)
 * can never merge into it. Contiguity is strict, not an overlap test, because two
 * identical translucent ops at the same place must stay two: the rocket's smoke
 * is three `alpha: 0.7` puffs stacked on one cell, and folding them into one
 * would drop two-thirds of the blend.
 */
function appendBlock(out: Pixel[], group: readonly Pixel[]): void {
  for (const rect of group) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.x === rect.x &&
      last.w === rect.w &&
      last.color === rect.color &&
      last.alpha === rect.alpha &&
      rect.y === last.y + last.h
    ) {
      out[out.length - 1] = {
        x: last.x,
        y: last.y,
        w: last.w,
        h: last.h + rect.h,
        color: last.color,
        alpha: last.alpha,
      };
      continue;
    }
    out.push(rect);
  }
}

/**
 * Merge vertically contiguous, identically shaped and coloured rects into one
 * block, unioning the columns PRESENT IN THIS GROUP (one op's rects). Kept in
 * insertion order, so a group's output is deterministic and a test can name the
 * rect it means. Called per op (`pixels`) — never across ops: the caller's order
 * is the painter's order, so two ops must stay two (see `appendBlock`).
 */
function mergeDown(rects: readonly Pixel[]): readonly Pixel[] {
  const columns = new Map<
    string,
    { x: number; y: number; w: number; h: number; color: string; alpha: number }[]
  >();
  const order: string[] = [];
  for (const rect of rects) {
    const key = `${rect.x}|${rect.w}|${rect.color}|${rect.alpha}`;
    const list = columns.get(key);
    if (list === undefined) {
      columns.set(key, [
        { x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: rect.color, alpha: rect.alpha },
      ]);
      order.push(key);
    } else {
      list.push({
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        color: rect.color,
        alpha: rect.alpha,
      });
    }
  }
  const out: Pixel[] = [];
  for (const key of order) {
    const list = [...(columns.get(key) ?? [])].sort((a, b) => a.y - b.y);
    let run: Pixel | null = null;
    for (const rect of list) {
      if (run !== null && rect.y <= run.y + run.h) {
        const bottom = Math.max(run.y + run.h, rect.y + rect.h);
        run = {
          x: run.x,
          y: run.y,
          w: run.w,
          h: bottom - run.y,
          color: run.color,
          alpha: run.alpha,
        };
      } else {
        if (run !== null) {
          out.push(run);
        }
        run = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: rect.color, alpha: rect.alpha };
      }
    }
    if (run !== null) {
      out.push(run);
    }
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------
 * Which scene, and in which palette (owner decisions 1 and 3)
 * ---------------------------------------------------------------------------
 */

/** A palette drawn at random (`rand() === 1` is clamped rather than off the end). */
export function pickMascotPalette(rand: () => number = Math.random): MascotPaletteName {
  const index = Math.min(
    PALETTE_NAMES.length - 1,
    Math.max(0, Math.floor(rand() * PALETTE_NAMES.length)),
  );
  return PALETTE_NAMES[index] ?? "soft";
}

/**
 * A scene that is NOT `last` — one of the other eight, uniformly. `last === null`
 * (the first empty session of this run) may draw any of the nine.
 */
export function pickScene(
  last: MascotSceneKey | null,
  rand: () => number = Math.random,
): MascotScene {
  const pool = MASCOT_SCENES.filter((scene) => scene.key !== last);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  const picked = pool[index];
  // `pool` is never empty (nine scenes, one excluded), so this is unreachable:
  // it exists so a caller never receives `undefined`.
  return picked ?? MASCOT_SCENES[0] ?? para;
}

/**
 * The app-wide memory of the last scene played — in memory only (owner decision 3:
 * a scene never repeats twice in a row, across sessions). `plays` counts them, so
 * a test can tell the first play (no constraint) from a later one.
 */
export interface SceneMemory {
  last: MascotSceneKey | null;
  plays: number;
}

/** The app's one instance (`ui/MascotScene.tsx` passes it to `drawOnce`). */
export const sceneMemory: SceneMemory = { last: null, plays: 0 };

/**
 * What ONE mount of the layer draws, decided once and then held: the scene, its
 * palette, and which run this is — app-wide, 0-based. `run` is why Paracadute
 * walks off a different side on every play (owner decision 2) and why
 * Mimetismo's palette switches start somewhere else: it is `memory.plays`
 * BEFORE this play is counted, so consecutive mounts are 0, 1, 2, …
 */
export interface MascotDraw {
  readonly scene: MascotSceneKey;
  readonly palette: MascotPaletteName;
  readonly run: number;
}

/** Pick this session's scene, palette and run, and record the play (owner decisions 1–4). */
export function drawOnce(memory: SceneMemory, rand: () => number = Math.random): MascotDraw {
  const run = memory.plays;
  const picked = nextScene(memory, rand);
  return { scene: picked.key, palette: pickMascotPalette(rand), run };
}

/** Pick this session's scene and record it (the store half of the rule). */
export function nextScene(memory: SceneMemory, rand: () => number = Math.random): MascotScene {
  const picked = pickScene(memory.last, rand);
  memory.last = picked.key;
  memory.plays += 1;
  return picked;
}
