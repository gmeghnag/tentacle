/**
 * The Browser page (docs/feat/browser-inspect.md B6b, owner Q3-B): a page of the
 * Session info sheet, with `‹ Session info` back to it — the Chrome link, this
 * session's three switches and the tabs of its group. RENDER ONLY (AGENTS §7):
 * every row, wording and lock is `browser-view.ts`'s, and a switch shows the
 * daemon's value, never the tap's.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BrowserPageRow, BrowserPageView } from "../browser-view.ts";
import { type Palette, space, typography } from "../theme.ts";
import { BandNote, BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Text } from "../ui/Text.tsx";

export interface BrowserPageProps {
  readonly palette: Palette;
  readonly view: BrowserPageView;
  /** The sheet's offline banner, when the link is down. */
  readonly banner?: string;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onSwitch: (kind: "tool" | "browser", name: string, enabled: boolean) => void;
  /** A tap on a locked row (the light haptic; its label already says why). */
  readonly onLockedTap: () => void;
}

function PageRow({
  palette,
  row,
  first,
  onSwitch,
  onLockedTap,
}: {
  readonly palette: Palette;
  readonly row: BrowserPageRow;
  readonly first: boolean;
  readonly onSwitch: BrowserPageProps["onSwitch"];
  readonly onLockedTap: () => void;
}): JSX.Element {
  const toggle = row.switch;
  return (
    <Row
      palette={palette}
      title={row.title}
      {...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })}
      {...(row.value === undefined ? {} : { value: row.value, trailingKind: "value" as const })}
      first={first}
      onSheet
      minHeight={44}
      dimmed={row.dim === true}
      {...(row.locked === true ? { onPress: onLockedTap } : {})}
      {...(toggle === undefined
        ? {}
        : {
            trailingKind: "control" as const,
            trailing: (
              <Switch
                testID={`browser-page-${row.id}-switch`}
                accessibilityLabel={toggle.accessibilityLabel}
                value={toggle.on}
                disabled={!toggle.interactive}
                onValueChange={(on) => onSwitch(toggle.kind, toggle.name, on)}
              />
            ),
          })}
      testID={`browser-page-${row.id}`}
    />
  );
}

export function BrowserPage({
  palette,
  view,
  banner,
  onBack,
  onClose,
  onSwitch,
  onLockedTap,
}: BrowserPageProps): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <Sheet
      palette={palette}
      title="Browser"
      testID="browser-page-sheet"
      insetBottom={false}
      scroll
      native
      onClose={onClose}
      closeTestID="browser-page-close"
      scrollTestID="browser-page-scroll"
    >
      <Pressable
        testID="browser-page-back"
        accessibilityRole="button"
        accessibilityLabel="Back to Session info"
        onPress={onBack}
        style={styles.back}
      >
        <Text style={[typography.subhead, { color: palette.accent }]}>‹ Session info</Text>
      </Pressable>
      {banner === undefined ? null : (
        <Banner
          palette={palette}
          tone="warn"
          icon="wifi.slash"
          body={banner}
          testID="browser-page-offline"
        />
      )}
      {view.empty === undefined ? null : (
        <BandSection palette={palette} onSheet>
          <Row palette={palette} title={view.empty} first onSheet minHeight={44} dimmed />
        </BandSection>
      )}
      {view.bands.map((band) => (
        <BandSection
          key={band.id}
          palette={palette}
          title={band.title}
          onSheet
          notes={
            band.note === undefined
              ? []
              : [
                  <BandNote key="note" palette={palette} testID={`browser-page-note-${band.id}`}>
                    {band.note}
                  </BandNote>,
                ]
          }
        >
          {band.rows.map((row, index) => (
            <PageRow
              key={row.id}
              palette={palette}
              row={row}
              first={index === 0}
              onSwitch={onSwitch}
              onLockedTap={onLockedTap}
            />
          ))}
        </BandSection>
      ))}
      <View style={{ height: insets.bottom + 20 }} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: "flex-start", paddingHorizontal: space.rowX, paddingVertical: 8 },
});
