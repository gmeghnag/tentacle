/**
 * A workflow phase's MARKER, drawn (docs/fix/workflows-ux.md D4, slice S6b): the
 * soft tinted disc with the SF glyph in ink, or — `not run` — a dotted ring with a
 * glyph and no body at all. A dumb renderer (AGENTS §7): the look comes from
 * `workflow-marker.ts`, and this file only turns it into a circle and a glyph, so
 * the pill, the summary strip (and S7's rail) cannot draw one phase three ways.
 *
 * A `running` marker blinks on the ONE shared rhythm (`STEP_BLINK_LOOP_MS`, the
 * running step dot's own clock constant) and is still under Reduce Motion.
 */
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { STEP_BLINK_LOOP_MS } from "../step-blink.ts";
import type { Palette } from "../theme.ts";
import { WR_GLYPH } from "../workflow-marker.ts";
import type { MarkerLook } from "../workflow-marker.ts";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";

export interface WorkflowMarkProps {
  readonly palette: Palette;
  readonly look: MarkerLook;
  /** The disc's diameter: 26 in a pill, 20 in the strip, 18 in a rail, 32 in the hero. */
  readonly size: number;
  /** The word for VoiceOver — the marker is never the only carrier of the state. */
  readonly label: string;
  /** A running phase blinks; Reduce Motion keeps it still. */
  readonly blink: boolean;
  readonly testID?: string;
}

export function WorkflowMark(props: WorkflowMarkProps): JSX.Element {
  const { look, size } = props;
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!props.blink) {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, {
          toValue: 0.4,
          duration: STEP_BLINK_LOOP_MS / 2,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(blink, {
          toValue: 1,
          duration: STEP_BLINK_LOOP_MS / 2,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      blink.setValue(1);
    };
  }, [props.blink, blink]);

  const body =
    look.soft === null
      ? null
      : { backgroundColor: look.soft, borderColor: "transparent", borderWidth: 0 };
  const glyph = look.symbol;
  return (
    <Animated.View
      testID={props.testID}
      accessibilityRole="image"
      accessibilityLabel={props.label}
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: look.ring === "dotted" ? size / 2 : size / 2,
          ...(look.ring === "dotted"
            ? // No body: the ring IS the shape (`not run`), so nothing can suggest
              // that something happened here.
              { borderStyle: "dotted" as const, borderWidth: 1.5, borderColor: look.ink }
            : body),
          opacity: props.blink ? blink : 1,
        },
      ]}
    >
      {glyph === null ? null : (
        <Icon name={glyph as IconName} color={look.ink} size={Math.round(size * WR_GLYPH)} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: "center", justifyContent: "center" },
});
