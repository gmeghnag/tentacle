/**
 * The banner under a screen's header (docs/fix/mobile-ask-surfaces.md, shared by
 * docs/fix/mobile-workflows-landing-v2.md D1): the one-row ask with `Review`. A
 * tap brings the ask's sheet up; nothing is answered here. Render only.
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import type { AskBannerView } from "../ask-park.ts";
import type { Palette } from "../theme.ts";
import { AskSlim } from "./AskSlim.tsx";

export interface AskBannerProps {
  readonly palette: Palette;
  readonly view: AskBannerView;
  readonly onPress: () => void;
  readonly testID: string;
}

export function AskBanner({ palette, view, onPress, testID }: AskBannerProps): JSX.Element {
  return (
    <View style={styles.askBanner}>
      <AskSlim
        testID={testID}
        palette={palette}
        title={view.title}
        originShort={view.originShort}
        more={view.more}
        actionLabel="Review"
        onPress={onPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  askBanner: { paddingHorizontal: 12, paddingTop: 6 },
});
