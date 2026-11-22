/**
 * Polpetto's scene layer over an EMPTY session (docs/feat/mobile-mascot-scenes.md,
 * owner decisions 22/11). A dumb renderer (AGENTS §7): `mascot-scenes.ts` owns
 * every decision — which scene, which frame, which pixels, which colours — and
 * this file owns only the clock and the `Svg` tree.
 *
 * The layer is absolutely positioned INSIDE the band between the header and the
 * composer, and clips its children. That is the whole z-order: the band's top
 * edge is the header's bottom, so the parachute, the helicopter and the UFO enter
 * from behind the header; its bottom edge is the composer's top, so `Sbuca dal
 * campo` and `Nuota` emerge from behind the composer. One layer suffices because
 * the mockup's `front` split is dead code (no scene sets it).
 *
 * It plays ONCE (owner decision 4): the clock stops at `durationMs` and the frame
 * list is empty from then on, so the screen stays empty until the next empty
 * session. The scene and its palette are drawn ONCE, when the layer mounts, so a
 * re-render or a resize never restarts it. Reduce Motion (owner decision 6) starts
 * no clock at all — Polpetto stands still at home.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import {
  type MascotDraw,
  type MascotGeometry,
  type Pixel,
  colorsFor,
  drawOnce,
  frameAt,
  pixels,
  rectKey,
  sceneByKey,
  sceneMemory,
  stillFrame,
} from "../mascot-scenes.ts";

export interface MascotSceneLayerProps {
  /** The band's measured size: the region between the screen header and the composer. */
  readonly geometry: MascotGeometry;
  /** Reduce Motion: no scene, no clock — the still frame at home. */
  readonly reduceMotion: boolean;
  /** A colour that reads on this appearance, for Mimetismo's leftover eyes. */
  readonly eyeFade: string;
  /** The last scene played, app-wide (owner decision 3: never the same twice in a row). */
  readonly memory?: typeof sceneMemory;
  /** Injectable for tests: the scene, palette and run this mount draws. */
  readonly pick?: () => MascotDraw;
}

export function MascotSceneLayer({
  geometry,
  reduceMotion,
  eyeFade,
  memory = sceneMemory,
  pick,
}: MascotSceneLayerProps): JSX.Element | null {
  // Drawn ONCE per mount (owner decision 4): a re-render, a resize or a theme
  // flip reuses all three, so a scene is never restarted mid-way.
  const [drawn] = useState<MascotDraw>(() => (pick === undefined ? drawOnce(memory) : pick()));
  const scene = sceneByKey(drawn.scene);
  const [elapsedMs, setElapsedMs] = useState(0);
  // The clock's origin, set by the first tick and never reset (a re-render must
  // not move it). `null` until the loop has started.
  const origin = useRef<number | null>(null);

  useEffect(() => {
    // Reduce Motion starts no clock, and a finished scene starts none either.
    if (reduceMotion) {
      return;
    }
    let live = true;
    let handle = 0;
    const tick = (): void => {
      if (!live) {
        return;
      }
      if (origin.current === null) {
        origin.current = Date.now();
      }
      const elapsed = Date.now() - origin.current;
      if (elapsed >= scene.durationMs) {
        // The scene is over: one last state, then no more frames (owner 4).
        setElapsedMs(scene.durationMs);
        return;
      }
      setElapsedMs(elapsed);
      handle = globalThis.requestAnimationFrame(tick);
    };
    handle = globalThis.requestAnimationFrame(tick);
    return () => {
      live = false;
      globalThis.cancelAnimationFrame(handle);
    };
  }, [reduceMotion, scene.durationMs]);

  // Nothing to draw before the band is measured (no flash at the top, no divide).
  if (geometry.width <= 0 || geometry.height <= 0) {
    return null;
  }
  const ops = reduceMotion ? stillFrame() : frameAt(scene, elapsedMs, drawn.run, { eyeFade });
  const rects: readonly Pixel[] = pixels(ops, geometry, colorsFor(drawn.palette));
  if (rects.length === 0) {
    return null;
  }
  return (
    <View
      testID="mascot"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.layer, { width: geometry.width, height: geometry.height }]}
    >
      <Svg width={geometry.width} height={geometry.height}>
        {rects.map((rect, index) => (
          <Rect
            key={rectKey(rect, index)}
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={rect.color}
            opacity={rect.alpha}
          />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    left: 0,
    top: 0,
    // The band's own edges are the clip: the header above, the composer below.
    overflow: "hidden",
  },
});
