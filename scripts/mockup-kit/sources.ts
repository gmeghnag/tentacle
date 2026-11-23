/**
 * Where every value the mockup kit shows comes from (docs/feat/mobile-mockup-kit.md
 * Slice 1c/1d). NAMED imports on purpose: renaming a token, a timing or a glyph
 * in source breaks `tsc --noEmit` here (root tsconfig includes `scripts/**`).
 */
import { join } from "node:path";
import {
  FADE_MS as CHART_FADE_MS,
  DRAW_MS,
  FADE_DELAY_MS,
  REDUCED_MS,
} from "../../apps/mobile/src/chart-interact.ts";
import { COMPACTED_SHOWN_MS } from "../../apps/mobile/src/compact-slot.ts";
import * as drawerNav from "../../apps/mobile/src/drawer-nav.ts";
import * as floatingButton from "../../apps/mobile/src/floating-button.ts";
import { FADE_MS as FLOAT_FADE_MS, FLOAT_SIZE } from "../../apps/mobile/src/floating-button.ts";
import { LANDING_REVEAL_MS, SETTLE_MS } from "../../apps/mobile/src/follow.ts";
import * as hubFan from "../../apps/mobile/src/hub-fan.ts";
import { FLASH_MS } from "../../apps/mobile/src/hub-flash.ts";
import {
  HOME_INSET_PT,
  SPRITE_PT,
  colorsFor,
  frameAt,
  pixels,
  sceneByKey,
  stillFrame,
} from "../../apps/mobile/src/mascot-scenes.ts";
import * as motion from "../../apps/mobile/src/motion.ts";
import { NOTICE_GLYPHS } from "../../apps/mobile/src/notice-group.ts";
import { ARM_MS } from "../../apps/mobile/src/permission-sheet.ts";
import * as stepRail from "../../apps/mobile/src/step-rail.ts";
import { FIGTREE_FACES, figtreeFace } from "../../apps/mobile/src/theme-beta.ts";
import * as theme from "../../apps/mobile/src/theme.ts";
import {
  BREATHE_MS,
  DOT_ORDER,
  SHIMMER_MS,
  breatheCurve,
  shimmerSweep,
  thinkingLabel,
  thinkingLook,
} from "../../apps/mobile/src/thinking-motion.ts";
import { thinkingA11yLabel, thoughtRowView } from "../../apps/mobile/src/tool-steps.ts";
import chalk from "../../packages/tui/node_modules/chalk/source/index.js";
import { BLINK_HALF_MS, BULLET } from "../../packages/tui/src/blink.ts";
import { formatDuration } from "../../packages/tui/src/format.ts";
import { inputRender } from "../../packages/tui/src/input-view.ts";
import { HARNESS_GLYPHS, itemLines } from "../../packages/tui/src/render-lines.ts";
import {
  SHIMMER_PAUSE_TICKS,
  SHIMMER_TICK_MS,
  SHIMMER_WINDOW,
} from "../../packages/tui/src/shimmer.ts";
import { ARC } from "../../packages/tui/src/spinner.ts";
import { setThemeMode, themeMode, tokens } from "../../packages/tui/src/theme.ts";
import type { GenInput } from "./emit.ts";
import { type Value, extractStyles } from "./extract-styles.ts";
import { MANIFEST } from "./manifest.ts";
import { TUI_INPUTS, TUI_ITEMS, TUI_SLOT_SECONDS, TUI_WIDTH } from "./tui-cases.ts";

export const ROOT = join(import.meta.dir, "../..");

/** The TUI's thinking slot: its braille `FRAMES` are module-private, so they are READ (folded). */
const THINKING_TSX = "packages/tui/src/components/Thinking.tsx";

/** Files whose blob sha the kit records (the modules above, plus the manifest's). */
const HASHED = [
  "apps/mobile/src/theme.ts",
  "apps/mobile/src/step-rail.ts",
  "apps/mobile/src/theme-beta.ts",
  "apps/mobile/src/motion.ts",
  "apps/mobile/src/thinking-motion.ts",
  "apps/mobile/src/tool-steps.ts",
  "apps/mobile/src/chat-header.ts",
  "packages/tui/src/theme.ts",
  "packages/tui/src/blink.ts",
  "packages/tui/src/spinner.ts",
  "packages/tui/src/shimmer.ts",
  // Not render-lines.ts / input-view.ts (large, often edited): their OUTPUT is
  // in kit-data (`viewModels.tui`), so a change that matters is caught anyway.
  THINKING_TSX,
];

export function tuiViewModels(files: Readonly<Record<string, string>>): Record<string, Value> {
  const prevLevel = chalk.level;
  const prevMode = themeMode();
  const rows: Record<string, Record<string, string[]>> = {};
  try {
    chalk.level = 3;
    for (const mode of ["dark", "light"] as const) {
      setThemeMode(mode);
      rows[mode] = Object.fromEntries(
        Object.entries(TUI_ITEMS).map(([k, v]) => [
          k,
          itemLines(v.item, { expandAll: false, width: TUI_WIDTH, blinkPhase: v.blinkPhase ?? 0 }),
        ]),
      );
    }
  } finally {
    chalk.level = prevLevel;
    setThemeMode(prevMode);
  }
  const input = Object.fromEntries(
    Object.entries(TUI_INPUTS).map(([k, v]) => {
      const r = inputRender(v.value, v.cursor, null, 10, TUI_WIDTH, "");
      return [
        k,
        r.rows.map((row) => ({
          prefix: row.prefix,
          gutter: row.gutter,
          segments: row.segments.map((s) => ({ text: s.text, inverse: s.inverse })),
        })),
      ];
    }),
  );
  const thinking = extractStyles({
    id: "tui-thinking",
    file: THINKING_TSX,
    source: files[THINKING_TSX] ?? "",
    modules: {},
    requireStyles: false,
  }).consts.FRAMES;
  if (!Array.isArray(thinking)) {
    throw new Error(`mockup-kit: ${THINKING_TSX} no longer has a foldable FRAMES`);
  }
  return {
    width: TUI_WIDTH,
    rows,
    input,
    slot: {
      frames: thinking,
      duration: Object.fromEntries(TUI_SLOT_SECONDS.map((s) => [String(s), formatDuration(s)])),
    },
  };
}

/**
 * Glyphs drawn as JSX text in a component (not importable). Each is CHECKED
 * against its source at generation, so a changed glyph fails loudly instead of
 * the kit keeping a stale copy.
 */
const JSX_GLYPHS: readonly {
  readonly key: string;
  readonly glyph: string;
  readonly file: string;
}[] = [
  { key: "wake", glyph: "◷", file: "apps/mobile/src/ui/StepNode.tsx" },
  { key: "therefore", glyph: "∴", file: "apps/mobile/src/ui/StepNode.tsx" },
];

const motionTimings = (): Record<string, number> =>
  Object.fromEntries(
    Object.entries(motion as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === "number" && e[0].endsWith("_MS"))
      .map(([k, v]) => [k.replace(/_MS$/, ""), v]),
  );

const motionNumbers = (): Record<string, number> =>
  Object.fromEntries(
    Object.entries(motion as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number" && !e[0].endsWith("_MS"),
    ),
  );

export async function readFiles(root: string = ROOT): Promise<Record<string, string>> {
  const paths = [...new Set([...HASHED, ...MANIFEST.map((m) => m.file)])];
  const files: Record<string, string> = {};
  for (const p of paths) {
    files[p] = await Bun.file(join(root, p)).text();
  }
  return files;
}

export function glyphsFrom(files: Readonly<Record<string, string>>): Record<string, Value> {
  const out: Record<string, Value> = {
    bullet: BULLET,
    blinkHalfMs: BLINK_HALF_MS,
    spinner: { frames: [...ARC.frames], intervalMs: ARC.intervalMs },
    shimmer: { window: SHIMMER_WINDOW, pauseTicks: SHIMMER_PAUSE_TICKS, tickMs: SHIMMER_TICK_MS },
    harness: { ...HARNESS_GLYPHS },
    notice: { ...NOTICE_GLYPHS },
  };
  for (const g of JSX_GLYPHS) {
    if (!(files[g.file] ?? "").includes(g.glyph)) {
      throw new Error(`mockup-kit: glyph ${g.key} "${g.glyph}" is no longer in ${g.file}`);
    }
    out[g.key] = g.glyph;
  }
  return out;
}

/**
 * `chat-header.ts` is pure at runtime but imports a TYPE from `ui/StatusDot.tsx`,
 * which drags react-native's global types into the root `tsc` (they redefine
 * `fetch`'s `BodyInit` and break `packages/config`). So it is loaded by a
 * specifier tsc does not follow, and its shape is checked here instead: a
 * rename still fails loudly — at generation, in the drift test.
 */
const CHAT_HEADER: string = join(import.meta.dir, "../../apps/mobile/src/chat-header.ts");

type DotLookFn = (dot: string) => Record<string, Value>;

async function loadDotLook(): Promise<DotLookFn> {
  const mod = (await import(CHAT_HEADER)) as { dotLook?: unknown };
  if (typeof mod.dotLook !== "function") {
    throw new Error("mockup-kit: apps/mobile/src/chat-header.ts no longer exports dotLook");
  }
  return mod.dotLook as DotLookFn;
}

/** The pure view-models, evaluated over canonical inputs (the kit never re-derives them). */
export function viewModels(dotLook: DotLookFn): Record<string, Value> {
  const dots = ["running", "ask", "connecting", "offline", "attention"] as const;
  return {
    headerDot: Object.fromEntries(dots.map((d) => [d, { ...dotLook(d) }])),
    thinkingLabel: Object.fromEntries(
      [0, 3_000, 65_000].map((ms) => [String(ms), { ...thinkingLabel(ms) }]),
    ),
    thinkingA11y: Object.fromEntries(
      [0, 3_000, 65_000].map((ms) => [String(ms), thinkingA11yLabel(ms)]),
    ),
    thinkingLook: { animate: { ...thinkingLook(false) }, still: { ...thinkingLook(true) } },
    thoughtRow: Object.fromEntries(
      [undefined, 400, 12_000, 95_000].map((ms) => [
        String(ms ?? "none"),
        { ...thoughtRowView({ ms }) },
      ]),
    ),
    breathe: {
      dotOrder: [...DOT_ORDER],
      curves: DOT_ORDER.map((_, i) => {
        const c = breatheCurve(i);
        return { inputRange: [...c.inputRange], outputRange: [...c.outputRange] };
      }),
    },
    shimmerSweep: (() => {
      const s = shimmerSweep(64);
      return {
        width: 64,
        band: s.band,
        from: s.from,
        to: s.to,
        stops: s.stops.map((x) => ({ ...x })),
      };
    })(),
    hubButton: { size: FLOAT_SIZE },
    mascot: mascotViewModel(),
  };
}

/**
 * Polpetto as the app draws him (`mascot-scenes.ts` `pixels`): rects relative to
 * the home's top-left corner (a geometry whose home is (0, 0)), in the `mint`
 * palette of the owner's screenshot. `still` is Reduce Motion's frame; `skate`
 * the Skateboard scene braked at home (t = 2.5 s, eyes open).
 */
function mascotViewModel(): Record<string, Value> {
  const geometry = { width: SPRITE_PT, height: SPRITE_PT + HOME_INSET_PT };
  const colors = colorsFor("mint");
  const rects = (ops: Parameters<typeof pixels>[0]): Value =>
    pixels(ops, geometry, colors).map((r) => ({ ...r }));
  return {
    palette: "mint",
    homeInset: HOME_INSET_PT,
    sprite: SPRITE_PT,
    still: rects(stillFrame()),
    skate: rects(frameAt(sceneByKey("skate"), 2_500)),
  };
}

export async function loadInput(root: string = ROOT): Promise<GenInput> {
  const files = await readFiles(root);
  const { lightPalette, darkPalette, petrolPalette, chartTokensFor } = theme;
  return {
    palettes: {
      light: { ...lightPalette },
      dark: { ...darkPalette },
      petrol: { ...petrolPalette },
    },
    chart: {
      light: { ...chartTokensFor(lightPalette) },
      dark: { ...chartTokensFor(darkPalette) },
      petrol: { ...chartTokensFor(petrolPalette) },
    },
    typography: theme.typography,
    radius: theme.radius,
    size: theme.size,
    space: theme.space,
    shadow: theme.shadow,
    figtree: { faces: FIGTREE_FACES, face: (w, style) => figtreeFace(w, style) },
    tui: {
      dark: tokens.dark as unknown as Record<string, unknown>,
      light: tokens.light as unknown as Record<string, unknown>,
    },
    numbers: motionNumbers(),
    timings: {
      ...motionTimings(),
      BREATHE: BREATHE_MS,
      THINKING_SHIMMER: SHIMMER_MS,
      HUB_FLASH: FLASH_MS,
      FLOAT_FADE: FLOAT_FADE_MS,
      FOLLOW_SETTLE: SETTLE_MS,
      LANDING_REVEAL: LANDING_REVEAL_MS,
      CHART_DRAW: DRAW_MS,
      CHART_FADE_DELAY: FADE_DELAY_MS,
      CHART_FADE: CHART_FADE_MS,
      CHART_REDUCED: REDUCED_MS,
      COMPACTED_SHOWN: COMPACTED_SHOWN_MS,
      PERMISSION_ARM: ARM_MS,
      TUI_BLINK_HALF: BLINK_HALF_MS,
      TUI_SHIMMER_TICK: SHIMMER_TICK_MS,
      TUI_SPINNER_FRAME: ARC.intervalMs,
    },
    easing: { HEADER_DOT: motion.HEADER_DOT_EASING },
    glyphs: glyphsFrom(files),
    viewModels: { ...viewModels(await loadDotLook()), tui: tuiViewModels(files) },
    modules: {
      "apps/mobile/src/theme.ts": theme as unknown as Record<string, unknown>,
      "apps/mobile/src/motion.ts": motion as unknown as Record<string, unknown>,
      "apps/mobile/src/hub-fan.ts": hubFan as unknown as Record<string, unknown>,
      "apps/mobile/src/floating-button.ts": floatingButton as unknown as Record<string, unknown>,
      "apps/mobile/src/drawer-nav.ts": drawerNav as unknown as Record<string, unknown>,
      "apps/mobile/src/step-rail.ts": stepRail as unknown as Record<string, unknown>,
    },
    files,
  };
}
