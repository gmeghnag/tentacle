/**
 * Polpetto's nine scenes (docs/feat/mobile-mascot-scenes.md Tests): the selection
 * rule (never the same scene twice in a row), the clock (`frameAt` at the start,
 * the middle and the end of each scene — arrivals land at home, exits leave the
 * screen, and the end draws NOTHING, owner decision 4), Reduce Motion's still
 * frame, the grid → points projection, and the row-run merge that keeps a frame
 * to a few dozen rects.
 *
 * The expected numbers are the mockup's own
 * (`docs/feat/mobile-mascot-scenes-mockup.html` `SCENES`): one grid unit is 6 pt,
 * the reference screen is 390×700 with the composer at y=610, and home is
 * (28, 80) — so at a 390×610 band home is (168, 480).
 */
import { describe, expect, test } from "bun:test";
import {
  HOME_GRID,
  MASCOT_SCENES,
  type MascotScene,
  type MascotSceneKey,
  type Op,
  PALETTE_NAMES,
  PIXEL_PT,
  type Pixel,
  SPRITE_PT,
  type SceneMemory,
  body,
  colorsFor,
  drawOnce,
  frameAt,
  homeAt,
  nextScene,
  pickMascotPalette,
  pickScene,
  pixels,
  rectKey,
  sceneByKey,
  sceneMemory,
  showsScene,
  stillFrame,
} from "../src/mascot-scenes.ts";

/** A deterministic generator (mulberry32), so "over many seeds" is reproducible. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Polpetto's own sprite in a frame: the only 9-row op (the canopy has 8, the
 * rocket 20, the helicopter 12, the balloon 11, the UFO 7, bubbles and flames
 * fewer than 6). `squash` keeps 9 rows, so a landing frame is still found.
 */
function bodyOp(ops: readonly Op[]): { x: number; y: number; rows: readonly string[] } | null {
  for (const op of ops) {
    if (op.kind === "sprite" && op.rows.length === 9) {
      return { x: op.x, y: op.y, rows: op.rows };
    }
  }
  return null;
}

/** Every sprite op that is not Polpetto (the props: canopy, rocket, UFO, …). */
function propOps(ops: readonly Op[]): { x: number; y: number; rows: readonly string[] }[] {
  return ops.flatMap((op) =>
    op.kind === "sprite" && op.rows.length !== 9 ? [{ x: op.x, y: op.y, rows: op.rows }] : [],
  );
}

const scene = (key: MascotSceneKey): MascotScene => {
  const found = MASCOT_SCENES.find((s) => s.key === key);
  if (found === undefined) {
    throw new Error(`no scene ${key}`);
  }
  return found;
};

/** The reference band: 390 wide, the transcript area 610 pt tall (the mockup's number). */
const BAND = { width: 390, height: 610 };

/** Grid units visible on the reference screen: 390 / 6 = 65 across, 610 / 6 ≈ 102 down. */
const GRID_W = 65;

/**
 * A frame rasterized cell by cell, IN ORDER: what each cell ends up showing.
 * A translucent rect is STACKED onto what is already there (`-` for nothing), so
 * two puffs of smoke on one cell differ from one — a plain last-wins map would
 * hide that the merge dropped a blend.
 */
function paint(rects: readonly Pixel[]): Map<string, string> {
  const cells = new Map<string, string>();
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += PIXEL_PT) {
      for (let x = r.x; x < r.x + r.w; x += PIXEL_PT) {
        const cell = `${x},${y}`;
        cells.set(
          cell,
          r.alpha < 1 ? `${cells.get(cell) ?? "-"}<${r.color}@${r.alpha}` : `${r.color}@${r.alpha}`,
        );
      }
    }
  }
  return cells;
}

describe("pickScene: never the same scene twice in a row (owner decision 3)", () => {
  test("over 10k seeds, no draw ever repeats the previous one", () => {
    const rand = seeded(7);
    let last: MascotSceneKey | null = null;
    const seen = new Set<MascotSceneKey>();
    for (let i = 0; i < 10_000; i++) {
      const picked = pickScene(last, rand);
      expect(picked.key === last).toBe(false);
      seen.add(picked.key);
      last = picked.key;
    }
    expect([...seen].sort()).toEqual(MASCOT_SCENES.map((s) => s.key).sort());
    expect(seen.size).toBe(9);
  });

  test("every excluded scene still leaves the other eight, each of them reachable", () => {
    for (const excluded of MASCOT_SCENES) {
      const keys = new Set(
        Array.from({ length: 400 }, (_, i) => pickScene(excluded.key, seeded(i + 1)).key),
      );
      expect(keys.has(excluded.key)).toBe(false);
      expect(keys.size).toBe(8);
    }
  });

  test("the first empty session (no previous scene) may draw any of the nine", () => {
    const keys = new Set(Array.from({ length: 400 }, (_, i) => pickScene(null, seeded(i + 1)).key));
    expect(keys.size).toBe(9);
  });

  test("`rand() === 1` is clamped rather than off the end", () => {
    expect(pickScene("para", () => 1).key).not.toBe("para");
    expect(pickMascotPalette(() => 1)).toBe("sky");
  });
});

describe("nextScene: the in-memory record, app-wide", () => {
  test("records the play and constrains the next one", () => {
    const memory: SceneMemory = { last: null, plays: 0 };
    const first = nextScene(memory, seeded(3));
    expect(memory.last).toBe(first.key);
    expect(memory.plays).toBe(1);
    const second = nextScene(memory, seeded(4));
    expect(second.key).not.toBe(first.key);
    expect(memory.plays).toBe(2);
  });

  test("the app's own instance starts empty", () => {
    expect({ last: sceneMemory.last, plays: sceneMemory.plays }).toEqual({ last: null, plays: 0 });
  });
});

describe("drawOnce: the scene, its palette and the run (owner decisions 1–4)", () => {
  test("consecutive mounts are run 0, 1, 2 — and each is recorded exactly once", () => {
    // `run` is what alternates Paracadute's two handednesses (owner decision 2)
    // and where Mimetismo's palette switches begin: a frozen 0 would replay the
    // same direction on every play.
    const memory: SceneMemory = { last: null, plays: 0 };
    expect([0, 1, 2].map(() => drawOnce(memory, seeded(7)).run)).toEqual([0, 1, 2]);
    expect(memory.plays).toBe(3);
  });

  test("the run it hands out is what a scene reads: two plays walk off opposite sides", () => {
    // The integration point the Review caught: `frameAt(…, 0, …)` froze `run`,
    // so Paracadute always walked off the same side (owner decision 2).
    const memory: SceneMemory = { last: null, plays: 0 };
    const runs = [drawOnce(memory, seeded(7)).run, drawOnce(memory, seeded(8)).run];
    const para = sceneByKey("para");
    const exit = runs.map((run) => {
      const at = bodyOp(frameAt(para, 10_599, run));
      return at === null ? null : Math.sign(at.x - HOME_GRID.x);
    });
    expect(exit).toEqual([1, -1]); // out to the right, then out to the left
  });

  test("never the same scene twice in a row, and the palette is one of the nine", () => {
    const memory: SceneMemory = { last: null, plays: 0 };
    const rand = seeded(23);
    const draws = Array.from({ length: 40 }, () => drawOnce(memory, rand));
    for (let i = 1; i < draws.length; i++) {
      expect(draws[i]?.scene).not.toBe(draws[i - 1]?.scene);
    }
    for (const draw of draws) {
      expect(PALETTE_NAMES).toContain(draw.palette);
    }
    expect(memory.plays).toBe(40);
  });
});

describe("pickMascotPalette: one of the nine, uniformly (owner decision 1)", () => {
  test("covers all nine palettes and never leaves them", () => {
    const rand = seeded(11);
    const seen = new Set(
      Array.from({ length: 2000 }, () => {
        const name = pickMascotPalette(rand);
        expect(PALETTE_NAMES).toContain(name);
        return name;
      }),
    );
    expect(seen.size).toBe(9);
  });

  test("0 and 1 are the ends of the table, not off it", () => {
    expect(pickMascotPalette(() => 0)).toBe("soft");
    expect(pickMascotPalette(() => 0.999_999)).toBe("sky");
  });
});

describe("frameAt: the clock, and the end is exclusive (owner decision 4)", () => {
  test("every scene draws nothing at its duration and after", () => {
    for (const s of MASCOT_SCENES) {
      expect({ scene: s.key, ops: frameAt(s, s.durationMs) }).toEqual({ scene: s.key, ops: [] });
      expect({ scene: s.key, ops: frameAt(s, s.durationMs + 5000) }).toEqual({
        scene: s.key,
        ops: [],
      });
    }
  });

  test("each scene draws for its whole life — Mimetismo's last breath is at 4.5 s", () => {
    // Every scene but Mimetismo still has pixels in its final frame; Mimetismo's
    // eyes vanish at 4.5 and its duration only lets the empty screen settle.
    const silentBeforeEnd = MASCOT_SCENES.filter((s) => frameAt(s, s.durationMs - 1).length === 0);
    expect(silentBeforeEnd.map((s) => s.key)).toEqual(["camo"]);
    for (const s of MASCOT_SCENES.filter((one) => one.key !== "camo")) {
      expect({ scene: s.key, drawn: frameAt(s, s.durationMs - 1).length > 0 }).toEqual({
        scene: s.key,
        drawn: true,
      });
    }
    expect(frameAt(scene("camo"), 4499).length).toBeGreaterThan(0);
  });

  test("a negative clock is the start", () => {
    for (const s of MASCOT_SCENES) {
      expect(frameAt(s, -50)).toEqual(frameAt(s, 0));
    }
  });
});

describe("Paracadute", () => {
  const s = scene("para");

  test("t=0: in the air above home, under the canopy", () => {
    const ops = frameAt(s, 0, 0);
    const hero = bodyOp(ops);
    expect(hero?.x).toBe(28);
    expect(hero?.y).toBe(-10);
    // The canopy (8 rows) rides 8 grid units above him, 2 to the left.
    expect(propOps(ops)).toEqual([
      expect.objectContaining({ x: 26, y: -18, rows: expect.any(Array) }),
    ]);
  });

  test("landing: a 1-px squash AT home, then he stands there", () => {
    const squashed = bodyOp(frameAt(s, 3300, 0));
    expect({ x: squashed?.x, y: squashed?.y }).toEqual({ x: 28, y: 80 });
    // "squash" shifts the drawing down one row and drops the legs row: the
    // sprite is still 9 rows, its first one empty.
    expect(squashed?.rows[0]).toBe(".........");
    expect(bodyOp(frameAt(s, 5900, 0))?.y).toBe(80);
  });

  test("the canopy falls away, fading, on the landing side", () => {
    // `run` 1 walks LEFT (dir = −1), so the falling canopy drifts left of home−2…
    const left = propOps(frameAt(s, 3550, 1))[0];
    const right = propOps(frameAt(s, 3550, 0))[0];
    expect(left?.x).toBe(28);
    expect(left?.y).toBe(76);
    // …and run 0 drifts right, so the two handednesses are visibly different.
    expect(right?.y).toBe(76);
    expect(right?.x).not.toBe(left?.x);
    // Falling = the canopy's top half only, and it fades as it drops.
    expect(left?.rows.length).toBe(4);
    const fading = frameAt(s, 3550, 1).find((op) => op.kind === "sprite" && op.rows.length === 4);
    expect(fading?.alpha).toBeGreaterThan(0);
    expect(fading?.alpha).toBeLessThan(1);
  });

  test("blinks at 4.5, looks aside after 5.3, then walks off alternating sides", () => {
    expect(bodyOp(frameAt(s, 4500, 0))?.rows[3]).toBe("KFFFFFFFK");
    expect(bodyOp(frameAt(s, 5600, 0))?.rows[3]).toBe("KFFEFFFEK"); // right
    expect(bodyOp(frameAt(s, 5600, 1))?.rows[3]).toBe("KEFFFEFFK"); // left
    // At the very end the walker is past the screen's last column, either way.
    expect(bodyOp(frameAt(s, 10_599, 0))?.x).toBeGreaterThan(GRID_W);
    expect(bodyOp(frameAt(s, 10_599, 1))?.x).toBeLessThan(0);
  });

  test("the legs alternate while walking", () => {
    // step = floor((t − 6.0)/0.11), legs = floor(step/2) % 2: a new leg frame
    // every 0.22 s, so the pattern repeats and both poses appear.
    const poses = new Set(
      [6.0, 6.11, 6.22, 6.33, 6.44, 6.55].map((s0) => bodyOp(frameAt(s, s0 * 1000, 0))?.rows[8]),
    );
    expect(poses.size).toBe(2);
    expect([...poses].sort()).toEqual([".KK.K.KK.", "KK..K..KK"]);
  });
});

describe("Skateboard", () => {
  const s = scene("skate");

  test("t=0: off the left edge; 1.8 s: home — and the board rides under him", () => {
    expect(bodyOp(frameAt(s, 0))?.x).toBeLessThan(0);
    const atHome = frameAt(s, 1800);
    expect(bodyOp(atHome)?.x).toBe(28);
    expect(bodyOp(atHome)?.y).toBe(80);
    // The board (3 rows) sits 8 grid units below the body, one column left.
    expect(propOps(atHome)).toEqual([expect.objectContaining({ x: 27, y: 88 })]);
  });

  test("looks left, then right, blinks, hops 1 px, then accelerates out right", () => {
    expect(bodyOp(frameAt(s, 3400))?.rows[3]).toBe("KEFFFEFFK"); // left
    expect(bodyOp(frameAt(s, 3900))?.rows[3]).toBe("KFFEFFFEK"); // right
    expect(bodyOp(frameAt(s, 2900))?.rows[3]).toBe("KFFFFFFFK"); // blink
    expect(bodyOp(frameAt(s, 4700))?.y).toBe(79); // the hop, 1 px up
    expect(bodyOp(frameAt(s, 6799))?.x).toBeGreaterThan(GRID_W);
  });
});

describe("Sbuca dal campo", () => {
  const s = scene("peek");

  test("starts BELOW the composer and rises behind it", () => {
    expect(s.behind).toBe(true);
    // Below the band's own bottom would be hidden; at rest he peeks at y = 96.
    expect(bodyOp(frameAt(s, 0))?.y).toBe(103);
    expect(bodyOp(frameAt(s, 700))?.y).toBe(96);
    expect(bodyOp(frameAt(s, 3000))?.y).toBe(96);
  });

  test("looks left then right, blinks, waves with a tentacle, sinks back", () => {
    expect(bodyOp(frameAt(s, 1200))?.rows[3]).toBe("KEFFFEFFK");
    expect(bodyOp(frameAt(s, 1800))?.rows[3]).toBe("KFFEFFFEK");
    expect(bodyOp(frameAt(s, 2600))?.rows[3]).toBe("KFFFFFFFK");
    // The wave (a 2-row tentacle) is to his right, and alternates two frames.
    const wave = propOps(frameAt(s, 3050));
    expect(wave).toEqual([expect.objectContaining({ x: 37, y: 98 })]);
    expect(propOps(frameAt(s, 3300))[0]?.rows).not.toEqual(wave[0]?.rows);
    expect(bodyOp(frameAt(s, 5799))?.y).toBe(103);
  });
});

describe("Nuota", () => {
  const s = scene("swim");

  test("starts behind the composer, bottom-left", () => {
    expect(s.behind).toBe(true);
    expect(bodyOp(frameAt(s, 0))?.x).toBe(-12);
    expect(bodyOp(frameAt(s, 0))?.y).toBe(112);
  });

  test("hovers at home bobbing 1 px, and blinks at 4.0", () => {
    expect(bodyOp(frameAt(s, 2800))?.x).toBe(28);
    expect(bodyOp(frameAt(s, 2800))?.y).toBe(80);
    expect(bodyOp(frameAt(s, 3500))?.y).toBe(81);
    expect(bodyOp(frameAt(s, 4000))?.rows[3]).toBe("KFFFFFFFK");
  });

  test("bubbles trail him and fade out within 1.2 s", () => {
    const bubble = frameAt(s, 300).find((op) => op.kind === "sprite" && op.rows.length === 1);
    expect(bubble?.alpha).toBeLessThan(1);
    const puffs = frameAt(s, 100).filter((op) => op.kind === "sprite" && op.rows.length === 1);
    expect(puffs.length).toBeGreaterThan(0);
  });

  test("swims out to the top-right", () => {
    const end = bodyOp(frameAt(s, 8599));
    expect(end?.x).toBe(70);
    expect(end?.y).toBe(-14);
  });
});

describe("Razzo", () => {
  const s = scene("rocket");

  test("walks in from the left and stops at x=22", () => {
    expect(bodyOp(frameAt(s, 0))?.x).toBe(-10);
    expect(bodyOp(frameAt(s, 2500))?.x).toBe(22);
  });

  test("the rocket stands 13×20 at (40, 69), empty until he hops in at 3.8", () => {
    const standing = propOps(frameAt(s, 100));
    expect(standing).toEqual([expect.objectContaining({ x: 40, y: 69 })]);
    expect(standing[0]?.rows.length).toBe(20);
    expect(standing[0]?.rows[7]).toBe("...CQQQQQC...");
    // Inside: his face shows at the window, and Polpetto is no longer drawn beside it.
    const inside = frameAt(s, 4000);
    expect(bodyOp(inside)).toBeNull();
    expect(propOps(inside)[0]?.rows[7]).toBe("...CFEFEFC...");
  });

  test("shakes with a small flame, then launches up off the top with flickering smoke", () => {
    const shaking = frameAt(s, 4200);
    expect(propOps(shaking).some((p) => p.rows.length === 2)).toBe(true); // the small flame
    expect([40, 41]).toContain(propOps(shaking)[0]?.x);
    const launched = propOps(frameAt(s, 7399));
    expect(launched[0]?.y).toBeLessThan(-16);
    // The smoke puffs sit around the pad, fading.
    const smoke = frameAt(s, 5200).filter((op) => op.kind === "sprite" && op.rows.length === 2);
    expect(smoke.length).toBeGreaterThan(0);
  });
});

describe("UFO", () => {
  const s = scene("ufo");

  test("Polpetto is at home from the start and notices at 1.6 s", () => {
    const start = bodyOp(frameAt(s, 0));
    expect({ x: start?.x, y: start?.y }).toEqual({ x: 28, y: 80 });
    expect(bodyOp(frameAt(s, 1800))?.rows[3]).toBe("KEFFFEFFK");
  });

  test("the saucer arrives from the left and parks above him", () => {
    const flying = propOps(frameAt(s, 0))[0];
    expect(flying?.x).toBeLessThan(0);
    // The saucer is the 7-row sprite (the «!» above him is 4 rows, pushed first).
    const saucer = (ms: number) => propOps(frameAt(s, ms)).find((p) => p.rows.length === 7);
    expect({ x: saucer(2200)?.x, y: saucer(2200)?.y }).toEqual({ x: 25, y: 22 });
    // Its two frames alternate the rim lights, every 150 ms.
    expect(saucer(2200)?.rows[4]).toBe("LCYCCYCCYCCYCCL");
    expect(saucer(2350)?.rows[4]).toBe("LCCYCCYCCYCCYCL");
  });

  test("a «!», then a widening beam that dematerialises him feet first with sparkles", () => {
    expect(propOps(frameAt(s, 2200)).some((p) => p.rows[0] === "Y")).toBe(true);
    const narrow = frameAt(s, 2500).filter((op) => op.kind === "rect");
    const wide = frameAt(s, 3300).filter((op) => op.kind === "rect");
    expect(narrow.length).toBeGreaterThan(0);
    expect(wide.length).toBeGreaterThan(narrow.length);
    // Feet first: the last row is blank before the whole sprite is.
    const halfGone = bodyOp(frameAt(s, 3400));
    expect(halfGone?.rows[8]).toBe(".........");
    expect(halfGone?.rows[0]).toBe("..KKKKK..");
    expect(bodyOp(frameAt(s, 3800))).toBeNull();
  });

  test("the beam retracts and the saucer leaves to the top-right", () => {
    expect(frameAt(s, 4050).filter((op) => op.kind === "rect").length).toBeLessThan(
      frameAt(s, 3300).filter((op) => op.kind === "rect").length,
    );
    expect(frameAt(s, 4150).filter((op) => op.kind === "rect")).toEqual([]);
    const leaving = propOps(frameAt(s, 6199))[0];
    expect(leaving?.x).toBeGreaterThan(GRID_W);
  });
});

describe("Mimetismo", () => {
  const s = scene("camo");

  test("switches palette eight times in two seconds, faster and faster", () => {
    const maps = [1050, 1550, 1950, 2250, 2500, 2700, 2850, 2950].map(
      (ms): Readonly<Record<string, string>> => {
        const op = frameAt(s, ms, 0)[0];
        return op?.kind === "sprite" ? (op.map ?? {}) : {};
      },
    );
    // Every switch is a different palette's outline colour…
    const outlines = maps.map((m) => m.K);
    expect(new Set(outlines).size).toBe(8);
    // …and each op carries the props' colours too, so the sprite stays whole.
    expect({ q: maps[0]?.Q }).toEqual({ q: colorsFor("soft").Q });
  });

  test("then fades out, leaving only the eyes — in the appearance's light colour", () => {
    const fading = frameAt(s, 3500, 0, { eyeFade: "#123456" })[0];
    expect(fading?.alpha).toBeGreaterThan(0);
    expect(fading?.alpha).toBeLessThan(1);
    const eyesOnly = frameAt(s, 4200, 0, { eyeFade: "#123456" })[0];
    expect(eyesOnly?.kind).toBe("sprite");
    if (eyesOnly?.kind !== "sprite") {
      throw new Error("not a sprite");
    }
    expect(eyesOnly.map).toEqual({ E: "#123456" });
    // Nothing but the eye pixels survives: the drawing is dots and `E` only, and
    // the two eye rows are the ones `body()` leaves visible.
    expect(eyesOnly.rows.every((row) => /^[.E]*$/.test(row))).toBe(true);
    expect(eyesOnly.rows.filter((row) => row.includes("E")).length).toBe(2);
    expect(eyesOnly.rows[3]).toBe("..E...E..");
  });

  test("the eyes blink once at 4.5 and then vanish", () => {
    expect(frameAt(s, 4500, 0, { eyeFade: "#123456" })).toEqual([]);
    // The blink is over at 4.65; the eyes then stand until 5.0, and then nothing.
    expect(frameAt(s, 4900, 0, { eyeFade: "#123456" }).length).toBe(1);
    expect(frameAt(s, 5000, 0, { eyeFade: "#123456" })).toEqual([]);
  });
});

describe("Palloncino", () => {
  const s = scene("balloon");

  test("walks in from the left holding the balloon on a string", () => {
    expect(bodyOp(frameAt(s, 0))?.x).toBe(-12);
    const held = frameAt(s, 1500);
    const balloonOp = propOps(held).find((p) => p.rows.length === 11);
    // Walking in: he is at x = 18 (step 600 of 0.05 s), the balloon 5 left of him.
    expect(balloonOp?.x).toBe(23);
    expect(balloonOp?.y).toBe(63);
    // The string is a column of 1-row ops from the balloon's bottom to his tentacle.
    expect(propOps(held).filter((p) => p.rows.length === 1).length).toBe(11);
  });

  test("stops, looks up, and the balloon lifts him off the top", () => {
    expect(bodyOp(frameAt(s, 2500))?.rows[3]).toBe("KFFFFFFFK");
    expect(bodyOp(frameAt(s, 3000))?.rows[4]).toBe("KFFFFFFFK"); // up
    const airborne = bodyOp(frameAt(s, 5000));
    expect(airborne?.y).toBeLessThan(80);
    expect(bodyOp(frameAt(s, 6599))?.y).toBeLessThan(0);
  });
});

describe("Elicottero (style B)", () => {
  const s = scene("heli");

  test("descends from the top with his face at the windscreen, 12 rows wide", () => {
    const high = propOps(frameAt(s, 0)).find((p) => p.rows.length === 12);
    expect(high?.y).toBeLessThan(-10);
    expect(propOps(frameAt(s, 300))[0]?.rows[5]).toBe("..KFEFEFK" + "SKKKSSSSKKKKKKKKKKKSK");
    expect(bodyOp(frameAt(s, 0))).toBeNull();
  });

  test("lands at (30, 77) raising dust, its rotor alternating two frames", () => {
    const landed = propOps(frameAt(s, 3000)).find((p) => p.rows.length === 12);
    expect({ x: landed?.x, y: landed?.y }).toEqual({ x: 30, y: 77 });
    const helicopter = (ms: number) => propOps(frameAt(s, ms)).find((p) => p.rows.length === 12);
    const frameA = helicopter(3000)?.rows[0];
    const frameB = helicopter(3060)?.rows[0];
    expect(frameA).not.toBe(frameB);
    // The dust: the two `LL` puffs, one each side, below and fading.
    const dust = frameAt(s, 2500).filter((op) => op.kind === "sprite" && op.rows.length === 1);
    expect(dust.map((op) => op.kind === "sprite" && op.x)).toEqual([29, 49]);
    expect(dust[0]?.alpha).toBeLessThan(1);
  });

  test("he hops out to the left, looks up, blinks and walks off to the left", () => {
    expect(bodyOp(frameAt(s, 3100))?.x).toBeGreaterThan(18);
    expect(bodyOp(frameAt(s, 4900))?.rows[4]).toBe("KFFFFFFFK"); // up
    expect(bodyOp(frameAt(s, 4000))?.rows[3]).toBe("KFFFFFFFK"); // blink
    const gone = bodyOp(frameAt(s, 9599));
    expect(gone?.x).toBeLessThan(0);
    // The helicopter itself has left the top.
    expect(propOps(frameAt(s, 9599)).filter((p) => p.rows.length === 12)).toEqual([]);
  });
});

describe("showsScene: the first row removes Polpetto at once (owner decisions 4 and 5)", () => {
  test("only an OPEN session with no rows shows a scene", () => {
    expect(showsScene({ phase: "open", rowCount: 0 })).toBe(true);
  });

  test("one row is enough to remove it — mid-scene, no ceremony", () => {
    expect(showsScene({ phase: "open", rowCount: 1 })).toBe(false);
    expect(showsScene({ phase: "open", rowCount: 40 })).toBe(false);
  });

  test("`opening` shows the loading state's own words, never Polpetto", () => {
    expect(showsScene({ phase: "opening", rowCount: 0 })).toBe(false);
  });

  test("a closed session draws nothing, even when its transcript is empty", () => {
    expect(showsScene({ phase: "failed", rowCount: 0 })).toBe(false);
    expect(showsScene({ phase: "", rowCount: 0 })).toBe(false);
  });
});

describe("Reduce Motion (owner decision 6)", () => {
  test("stands still at home, eyes open, one op", () => {
    const ops = stillFrame();
    expect(ops.length).toBe(1);
    const hero = bodyOp(ops);
    expect({ x: hero?.x, y: hero?.y }).toEqual({ x: 28, y: 80 });
    expect(hero?.rows[3]).toBe("KFEFFFEFK");
    expect(hero?.rows[8]).toBe(".KK.K.KK.");
  });
});

describe("homeAt: centred, just above the composer (owner decision 1)", () => {
  test("a 390×610 band reproduces the mockup: home at (168, 480)", () => {
    expect(homeAt(BAND)).toEqual({ x: 168, y: 480 });
  });

  test("the sprite is 54 pt and its bottom stays 76 pt above the band's bottom", () => {
    expect(SPRITE_PT).toBe(54);
    for (const width of [375, 390, 393, 430]) {
      const home = homeAt({ width, height: 700 });
      // Centred: the same margin on both sides…
      expect(home.x).toBe((width - SPRITE_PT) / 2);
      expect(width - (home.x + SPRITE_PT)).toBe(home.x);
      // …and 76 pt of band below the sprite, the mockup's own number.
      expect(700 - (home.y + SPRITE_PT)).toBe(76);
    }
  });

  test("a band shorter than the sprite keeps the home at its top", () => {
    expect(homeAt({ width: 390, height: 60 }).y).toBe(0);
    expect(homeAt({ width: 0, height: 0 }).y).toBe(0);
  });
});

describe("pixels: the one grid → points projection", () => {
  test("stillFrame at a 390×610 band is a 54×54 sprite at (168, 480)", () => {
    const rects = pixels(stillFrame(), BAND, colorsFor("soft"));
    expect(rects.length).toBeGreaterThan(0);
    const xs = rects.map((r) => r.x);
    const ys = rects.map((r) => r.y);
    expect(Math.min(...xs)).toBe(168);
    expect(Math.min(...ys)).toBe(480);
    expect(Math.max(...xs.map((x, i) => x + (rects[i]?.w ?? 0)))).toBe(168 + PIXEL_PT * 9);
    // The bottom row of the drawing is the legs' grid row 8: 480 + 8·6 = 528.
    expect(Math.max(...ys)).toBe(480 + PIXEL_PT * 8);
    expect(rects.every((r) => r.h % PIXEL_PT === 0 && r.h > 0)).toBe(true);
  });

  test("equal neighbours merge into one run: the top row is a single 5-px rect", () => {
    const rects = pixels(stillFrame(), BAND, colorsFor("soft"));
    const top = rects.filter((r) => r.y === 480);
    expect(top).toEqual([
      { x: 168 + 2 * PIXEL_PT, y: 480, w: 5 * PIXEL_PT, h: PIXEL_PT, color: "#7B3FC0", alpha: 1 },
    ]);
  });

  test("a later op still paints OVER an earlier one (the merge keeps the painter's order)", () => {
    // The merge must be per op: grouping across ops reorders them by first-seen
    // key, so the helicopter's face stopped covering its windscreen and the smoke
    // stopped stacking on the rocket. Painted cell by cell, in op order, the
    // frame must look the same as the ops drawn one op at a time.
    for (const s of MASCOT_SCENES) {
      for (let ms = 0; ms < s.durationMs; ms += 100) {
        const ops = frameAt(s, ms, 0, { eyeFade: "#000000" });
        const merged = paint(pixels(ops, BAND, colorsFor("soft")));
        const oneByOne = paint(ops.flatMap((op) => pixels([op], BAND, colorsFor("soft"))));
        expect({ scene: s.key, ms, cells: [...merged.keys()] }).toEqual({
          scene: s.key,
          ms,
          cells: [...oneByOne.keys()],
        });
        for (const [cell, color] of oneByOne) {
          if (merged.get(cell) !== color) {
            throw new Error(
              `${s.key} at ${ms} ms: ${cell} paints ${color}, got ${merged.get(cell)}`,
            );
          }
        }
      }
    }
  });

  test("the op that overlaps an earlier one keeps its own row", () => {
    // A named case of the above, so a regression says which scene broke: the
    // helicopter at 3.0 s draws Polpetto's face over the windscreen.
    const floor = (gx: number, gy: number): string =>
      `${168 + (gx - 28) * PIXEL_PT},${480 + (gy - 80) * PIXEL_PT}`;
    const cells = paint(pixels(frameAt(scene("heli"), 3000), BAND, colorsFor("soft")));
    expect(cells.get(floor(39, 82))).toBe("#A274DE@1"); // Polpetto's body
    expect(cells.get(floor(39, 80))).toBe("#7B3FC0@1"); // Polpetto's crown
  });

  test("a translucent op stacked on itself stays stacked (the rocket's smoke)", () => {
    // Strict contiguity, not an overlap test: three identical `alpha: 0.7` puffs
    // on one cell are three blends, and folding them into one keeps a third.
    const smoke = frameAt(scene("rocket"), 4800).filter(
      (op) => op.kind === "sprite" && op.rows.length === 2 && op.alpha === 0.7,
    );
    expect(smoke.length).toBe(3);
    const stacked = paint(pixels(frameAt(scene("rocket"), 4800), BAND, colorsFor("soft"))).get(
      `${168 + (45 - 28) * PIXEL_PT},${480 + (88 - 80) * PIXEL_PT}`,
    );
    // The rocket's own tone underneath, then one `<…` per puff: three blends.
    expect(stacked).toBe("#7B3FC0@1<#8d969e@0.7<#8d969e@0.7<#8d969e@0.7");
  });

  test("every rect in a frame has its own key, so React never reuses one (Review round 2)", () => {
    // The layer keys `<Rect>` by `rectKey`. Two identical translucent ops are
    // deliberately kept as two rects (see the smoke test above), so a key made of
    // the rect's SHAPE collides: React would warn every frame and could reuse or
    // drop a child, losing exactly the blend the merge was fixed to keep. Every
    // scene, every run, every frame, every palette.
    for (const s of MASCOT_SCENES) {
      for (const palette of PALETTE_NAMES) {
        for (let run = 0; run < 3; run += 1) {
          for (let ms = 0; ms < s.durationMs; ms += 10) {
            const rects = pixels(
              frameAt(s, ms, run, { eyeFade: "#000000" }),
              BAND,
              colorsFor(palette),
            );
            const keys = rects.map(rectKey);
            const dupes = keys.filter((key, i) => keys.indexOf(key) !== i);
            if (dupes.length > 0) {
              throw new Error(
                `${s.key}/${palette}/run${run} at ${ms} ms: ${dupes.length} duplicate key(s), e.g. ${dupes[0]}`,
              );
            }
          }
        }
      }
    }
  });

  test("the rocket's three stacked puffs get three keys, at the same place and colour", () => {
    // The named case: one cell, one shape, one colour, one alpha — three rects,
    // three keys. Nothing but the index can tell them apart.
    const rects = pixels(frameAt(scene("rocket"), 4800), BAND, colorsFor("soft"));
    const smoke = rects
      .map((rect, index) => ({ rect, key: rectKey(rect, index) }))
      .filter(({ rect }) => rect.color === "#8d969e" && rect.alpha === 0.7);
    expect(smoke.length).toBe(3);
    // Identical in every field a shape key could hold: only the index tells them apart.
    const [first] = smoke;
    if (first === undefined) {
      throw new Error("the rocket draws no smoke at 4.8 s");
    }
    const { x, y, w, h, color, alpha } = first.rect;
    expect(smoke.every(({ rect }) => rect.x === x && rect.y === y)).toBe(true);
    expect(smoke.every(({ rect }) => rect.w === w && rect.h === h)).toBe(true);
    expect(smoke.every(({ rect }) => rect.color === color && rect.alpha === alpha)).toBe(true);
    expect(new Set(smoke.map(({ key }) => key)).size).toBe(3);
  });

  test("no frame anywhere in any scene exceeds 120 rects", () => {
    // Measured worst case after both merges: the helicopter at 82. A frame is a
    // rAF tick, so this is the per-frame cost of the whole layer.
    for (const s of MASCOT_SCENES) {
      for (let ms = 0; ms < s.durationMs; ms += 50) {
        const count = pixels(frameAt(s, ms), BAND, colorsFor("soft")).length;
        if (count >= 120) {
          throw new Error(`${s.key} at ${ms} ms drew ${count} rects`);
        }
      }
    }
  });

  test("colours come from the palette's five tones plus the props'", () => {
    const colors = colorsFor("coral");
    expect(colors.K).toBe("#C2475A");
    expect(colors.Q).toBe("#9fdcea");
    // An op's own map wins over the palette (Mimetismo).
    const override = pixels(
      [{ kind: "sprite", rows: ["K"], x: 28, y: 80, map: { K: "#010203" } }],
      BAND,
      colors,
    );
    expect(override).toEqual([
      { x: 168, y: 480, w: PIXEL_PT, h: PIXEL_PT, color: "#010203", alpha: 1 },
    ]);
  });

  test("an unknown glyph and a fully faded op draw nothing", () => {
    const rects = pixels(
      [
        { kind: "sprite", rows: ["?"], x: 28, y: 80 },
        { kind: "sprite", rows: ["K"], x: 28, y: 80, alpha: 0 },
      ],
      BAND,
      colorsFor("soft"),
    );
    expect(rects).toEqual([]);
  });

  test("a rect op (the UFO's beam) maps through the same anchor", () => {
    const rects = pixels(
      [{ kind: "rect", rect: [28, 80, 3, 1], color: "Q", alpha: 0.24 }],
      BAND,
      colorsFor("soft"),
    );
    expect(rects).toEqual([
      { x: 168, y: 480, w: 3 * PIXEL_PT, h: PIXEL_PT, color: "#9fdcea", alpha: 0.24 },
    ]);
  });

  test("body()'s poses are the owner's drawing, one row edited at a time", () => {
    expect(body()).toEqual([
      "..KKKKK..",
      ".KSFFFSK.",
      "KSFFFFFSK",
      "KFEFFFEFK",
      "KFEFFFEFK",
      "KBBFSFBBK",
      ".KFFFFFK.",
      "KSSKSKSSK",
      ".KK.K.KK.",
    ]);
    expect(body({ legs: 2 })[7]).toBe(".KSKSKSK.");
    expect(body({ squash: true })[0]).toBe(".........");
    expect(body({ squash: true }).length).toBe(9);
  });
});
