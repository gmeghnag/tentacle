/**
 * A step row's elapsed clock (docs/feat/mobile-ui-fluidity-s2.md): the native
 * `ClockText` (`modules/tentacle-clock/`, it ticks on the UI thread) on a build
 * that has the module, else the same label drawn by JS over the one sampler
 * (`use-since.ts`). A dumb renderer: the value and the format are `clock.ts`'s.
 */
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { type ComponentType, type JSX, useContext } from "react";
import { StyleSheet, type ViewProps, useWindowDimensions } from "react-native";
import { type ClockFormat, formatClock } from "../clock.ts";
import { textFont } from "../theme-beta.ts";
import { DENSE_FONT_SCALE, typography } from "../theme.ts";
import { useSince } from "../use-since.ts";
import { Text } from "./Text.tsx";
import { AppFontContext } from "./app-font.ts";

export interface ClockTextProps {
  /** The event's own stamp (epoch ms). */
  readonly since: number;
  readonly format: ClockFormat;
  readonly color: string;
  /** Figures of one width, so the label holds still as it counts. */
  readonly tabular: boolean;
  readonly testID?: string;
}

interface NativeProps extends ClockTextProps, Pick<ViewProps, "style"> {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily?: string;
}

// iOS only: null on a build without the module (an older dev client, web).
const NativeClock: ComponentType<NativeProps> | null =
  requireOptionalNativeModule("TentacleClock") === null
    ? null
    : requireNativeView<NativeProps>("TentacleClock");

export function ClockText(props: ClockTextProps): JSX.Element | null {
  return NativeClock === null ? <JsClock {...props} /> : <Native view={NativeClock} {...props} />;
}

/** The native label takes RESOLVED type: what the RN `Text` would have drawn. */
function Native({
  view: View,
  ...props
}: ClockTextProps & { readonly view: ComponentType<NativeProps> }): JSX.Element {
  const { fontScale } = useWindowDimensions();
  const font = useContext(AppFontContext);
  const scale = Math.min(fontScale, DENSE_FONT_SCALE);
  const { fontSize, lineHeight, fontWeight } = typography.stepMeta;
  const face = textFont({ fontFamily: undefined, fontWeight, fontStyle: undefined }, {}, font).patch
    ?.fontFamily;
  return (
    <View
      {...props}
      fontSize={fontSize * scale}
      lineHeight={lineHeight * scale}
      {...(face === undefined ? {} : { fontFamily: face })}
      // The height holds before the view reports its own size.
      style={{ height: lineHeight * scale }}
    />
  );
}

function JsClock({ since, format, color, tabular, testID }: ClockTextProps): JSX.Element | null {
  const label = useSince(since, (ms) => (ms === null ? "" : formatClock(format, ms)));
  return label === "" ? null : (
    <Text
      testID={testID}
      numberOfLines={1}
      maxFontSizeMultiplier={DENSE_FONT_SCALE}
      style={[typography.stepMeta, { color }, tabular ? styles.tabular : undefined]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ["tabular-nums"] },
});
