/**
 * `Computers` — the computers this app knows, each with its single project row
 * (docs/feat/mobile-app-shell.md: one `serve` = one project in 11a; sibling
 * discovery is task 10). A dumb renderer (AGENTS §7): the row facts come from
 * `computer-rows.ts`, what is said about them and what the menu offers from
 * `computer-status.ts`.
 *
 * The look is the approved `Main` mockup (docs/feat/mobile-ui-polish.md, Slice 2),
 * restyled to E2 bands by S4 of docs/feat/mobile-chrome.md: a large title with two
 * thin header buttons (Settings, "+" to pair another computer), per computer a bold
 * heading (status dot + status line) over ONE full-width `BandSection` holding its
 * project row, and the "Pair a computer" band with its hint as the footnote.
 *
 * Pair again / Remove live in a menu (Owner Q5): a long-press on the project row
 * or the "…" next to the computer's name. A computer that cannot work without a
 * new pairing (`revoked` / `maybe-reset` / `broken`) ALSO shows "Pair again" in
 * its card, where the person is already looking (`computer-pair-again-<id>`).
 *
 * The menu and Remove's confirmation are an in-app action sheet, NOT
 * `ActionSheetIOS`/`Alert`: RN's new architecture exposes no native alert text or
 * button to XCUITest, so a flow could never prove that Remove does what its
 * wording says — every value a flow must check is a testID (plan P9). The one
 * sheet stays mounted while the menu turns into the confirmation, so iOS never
 * presents one modal while dismissing another.
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ComputerRow } from "../computer-rows.ts";
import { computerStatus, menuActions } from "../computer-status.ts";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, space, typography } from "../theme.ts";
import { ActionSheet, type SheetAction } from "../ui/ActionSheet.tsx";
import { BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InlineMono } from "../ui/InlineMono.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { Text } from "../ui/Text.tsx";

export type { ComputerRow };

export interface ComputersScreenProps {
  readonly palette: Palette;
  readonly rows: readonly ComputerRow[];
  readonly error?: string;
  readonly onOpen: (row: ComputerRow) => void;
  /** Pair ANOTHER computer (the header "+" and the bottom card). */
  readonly onAdd: () => void;
  /** Open a computer's menu (long-press, or its "…"). */
  readonly onMenu: (row: ComputerRow) => void;
  /** Whose menu is showing, if any. */
  readonly menu?: ComputerRow;
  /** The menu was dismissed without a choice. */
  readonly onMenuClosed: () => void;
  /** Ask to remove a computer from this phone (the screen shows its confirmation). */
  readonly onRemove: (row: ComputerRow) => void;
  /** The person confirmed Remove for this computer. */
  readonly onRemoveConfirmed: (row: ComputerRow) => void;
  /** The person backed out of a Remove. */
  readonly onRemoveCancelled: () => void;
  /** Which computer's confirmation is showing, if any. */
  readonly removing?: ComputerRow;
  /** "Pair again" (the menu, or the card of a row that needs it). */
  readonly onPairAgain: (row: ComputerRow) => void;
  /** Open Settings (docs/feat/mobile-lock.md D6). */
  readonly onOpenSettings: () => void;
}

export function ComputersScreen({
  palette,
  rows,
  error,
  onOpen,
  onAdd,
  onMenu,
  menu,
  onMenuClosed,
  onRemove,
  onRemoveConfirmed,
  onRemoveCancelled,
  removing,
  onPairAgain,
  onOpenSettings,
}: ComputersScreenProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const compact = useCompactTitle();
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <ScrollView
        testID="computers-list"
        style={{ backgroundColor: palette.bg }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        onScroll={compact.onScroll}
        scrollEventThrottle={compact.scrollEventThrottle}
      >
        <ScreenHeader
          palette={palette}
          title="Computers"
          right={
            <>
              <HeaderIcon
                testID="open-settings"
                palette={palette}
                icon="slider.horizontal.3"
                accessibilityLabel="Settings"
                onPress={onOpenSettings}
              />
              <HeaderIcon
                testID="computers-add"
                palette={palette}
                icon="plus"
                tone="accent"
                accessibilityLabel="Pair a computer"
                onPress={onAdd}
              />
            </>
          }
        />
        {error === undefined ? null : (
          <View style={styles.section}>
            <Banner
              palette={palette}
              tone="error"
              title="Can’t show your computers"
              body={error}
              bodyTestID="computers-error"
            />
          </View>
        )}
        {rows.map((row) => (
          <ComputerSection
            key={row.id}
            palette={palette}
            row={row}
            onOpen={onOpen}
            onMenu={onMenu}
            onPairAgain={onPairAgain}
          />
        ))}
        <View style={styles.section}>
          <BandSection
            palette={palette}
            footnote={
              <>
                Run{" "}
                <InlineMono palette={palette} size={typography.footnote.fontSize}>
                  tentacle pair
                </InlineMono>{" "}
                on the computer. Its projects show up here as soon as{" "}
                <InlineMono palette={palette} size={typography.footnote.fontSize}>
                  tentacle serve
                </InlineMono>{" "}
                runs in them.
              </>
            }
          >
            <Row
              testID="computers-pair-card"
              palette={palette}
              first
              icon="qrcode.viewfinder"
              tone="accent"
              title="Pair a computer"
              titleWeight="600"
              minHeight={SIZE.rowAction}
              onPress={onAdd}
            />
          </BandSection>
        </View>
      </ScrollView>
      <CompactBar palette={palette} title="Computers" shown={compact.shown} />
      <ActionSheet
        palette={palette}
        visible={removing !== undefined || menu !== undefined}
        {...sheetContent({ menu, removing, onPairAgain, onRemove, onRemoveConfirmed })}
        onCancel={removing === undefined ? onMenuClosed : onRemoveCancelled}
        {...(removing === undefined
          ? menu === undefined
            ? {}
            : { cancelTestID: `computer-menu-cancel-${menu.id}` }
          : { cancelTestID: `computer-remove-cancel-${removing.id}` })}
      />
    </View>
  );
}

function ComputerSection({
  palette,
  row,
  onOpen,
  onMenu,
  onPairAgain,
}: {
  readonly palette: Palette;
  readonly row: ComputerRow;
  readonly onOpen: (row: ComputerRow) => void;
  readonly onMenu: (row: ComputerRow) => void;
  readonly onPairAgain: (row: ComputerRow) => void;
}): JSX.Element {
  const status = computerStatus(row);
  const statusColor =
    status.tone === "online"
      ? palette.green
      : status.tone === "attention"
        ? palette.orange
        : palette.sec;
  return (
    <View style={styles.section}>
      <View style={styles.computerHeader}>
        <Icon name="laptopcomputer" color={palette.label} size={22} />
        <View style={styles.computerText}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.title3, { color: palette.label }]}
          >
            {row.name}
          </Text>
          <View style={styles.statusLine}>
            <StatusDot palette={palette} tone={status.tone} size={7} />
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[typography.footnote, { color: statusColor, fontWeight: "500" }]}
            >
              {status.text}
            </Text>
          </View>
        </View>
        <Pressable
          testID={`computer-menu-${row.id}`}
          accessibilityRole="button"
          accessibilityLabel={`More for ${row.name}`}
          onPress={() => onMenu(row)}
          hitSlop={6}
          style={styles.more}
        >
          <Icon name="ellipsis" color={palette.accent} size={22} />
        </Pressable>
      </View>
      <BandSection palette={palette}>
        <Row
          testID={`computer-${row.id}`}
          palette={palette}
          first
          icon="folder"
          iconDashed={row.state !== "ok"}
          dimmed={row.state !== "ok"}
          title={row.project}
          chevron
          onPress={() => onOpen(row)}
          onLongPress={() => onMenu(row)}
          accessibilityHint="Opens its sessions. Long-press for more."
        >
          {status.detail === undefined ? null : (
            <Text
              testID={row.state === "ok" ? undefined : `computer-state-${row.id}-${row.state}`}
              numberOfLines={3}
              style={[typography.footnote, { color: palette.sec }]}
            >
              {status.detail}
            </Text>
          )}
        </Row>
        {status.pairAgain ? (
          <Row
            testID={`computer-pair-again-${row.id}`}
            palette={palette}
            icon="arrow.clockwise"
            tone="accent"
            title="Pair again"
            minHeight={SIZE.rowAction}
            onPress={() => onPairAgain(row)}
          />
        ) : null}
      </BandSection>
    </View>
  );
}

/** The one sheet's content: Remove's confirmation if it is up, else the menu. */
function sheetContent({
  menu,
  removing,
  onPairAgain,
  onRemove,
  onRemoveConfirmed,
}: {
  readonly menu: ComputerRow | undefined;
  readonly removing: ComputerRow | undefined;
  readonly onPairAgain: (row: ComputerRow) => void;
  readonly onRemove: (row: ComputerRow) => void;
  readonly onRemoveConfirmed: (row: ComputerRow) => void;
}): { title?: string; message?: string; actions: readonly SheetAction[]; testID?: string } {
  if (removing !== undefined) {
    return {
      testID: `computer-remove-confirm-${removing.id}`,
      title: `Remove '${removing.name}'?`,
      message: removeMessage(removing),
      actions: [
        {
          label: "Remove",
          destructive: true,
          testID: `computer-remove-yes-${removing.id}`,
          onPress: () => onRemoveConfirmed(removing),
        },
      ],
    };
  }
  if (menu === undefined) {
    return { actions: [] };
  }
  return {
    testID: `computer-menu-sheet-${menu.id}`,
    title: menu.name,
    actions: menuActions(menu).map((action) =>
      action.kind === "remove"
        ? {
            label: action.label,
            destructive: action.destructive,
            testID: `computer-remove-${menu.id}`,
            onPress: () => onRemove(menu),
          }
        : {
            label: action.label,
            destructive: action.destructive,
            testID: `computer-menu-pair-again-${menu.id}`,
            onPress: () => onPairAgain(menu),
          },
    ),
  };
}

/**
 * What Remove's confirmation says under its title "Remove '<name>'?" (Owner Q5:
 * nothing is revoked from the phone, and the person is told exactly what to run on
 * the computer). A `broken` row has no usable key, so its wording says that
 * instead of naming a device.
 */
export function removeMessage(row: ComputerRow): string {
  if (row.state === "broken") {
    return "Its saved key is damaged, so this only forgets a broken entry on this phone.";
  }
  return "This forgets it on this phone only. To also revoke it on the computer, run “tentacle devices revoke <name>” there.";
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // BandSection owns the section rhythm (`space.sectionTop` above every band), so
  // a computer's block adds none: its heading carries the gap that separates two
  // computers, and the band brings the one under the heading.
  section: { marginTop: 0 },
  computerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: space.sectionTop,
    paddingLeft: space.inset + 4,
    paddingRight: space.inset - 4,
    // The band's own `sectionTop` supplies the rest of the gap under the heading
    // (Design 4's label→band 6 pt, plus the band's margin).
    paddingBottom: 6,
  },
  computerText: { flex: 1, gap: 2 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  more: {
    width: SIZE.touch,
    height: SIZE.touch,
    alignItems: "center",
    justifyContent: "center",
  },
});
