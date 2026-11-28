/**
 * The session screen's header (docs/feat/mobile-ui-fluidity-s3.md): the title
 * bar, the parked ask's banner and the session's banner. It follows the `header`
 * slice, so a streamed delta never re-renders it. A dumb renderer (AGENTS §7):
 * what it offers is the shell's `actions`.
 */
import { type JSX, memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { askBanner } from "../../ask-park.ts";
import { chatStatus, titleLabel } from "../../chat-header.ts";
import { PERF } from "../../perf-probe.ts";
import type { SessionStore } from "../../session-store.ts";
import type { SessionView } from "../../session-view.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, typography } from "../../theme.ts";
import { ActivityBadge } from "../../ui/ActivityBadge.tsx";
import { AskBanner } from "../../ui/AskBanner.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { ContextRing } from "../../ui/ContextRing.tsx";
import { HeaderDot } from "../../ui/HeaderDot.tsx";
import { HeaderIcon } from "../../ui/HeaderIcon.tsx";
import type { IconName } from "../../ui/Icon.tsx";
import { ScreenHeader } from "../../ui/ScreenHeader.tsx";
import { Text } from "../../ui/Text.tsx";
import { useSlice } from "../../use-slice.ts";
import type { PaneActionsRef } from "./actions.ts";

/** How each banner kind LOOKS (its text and its actions are `session-view.ts`'s). */
const BANNER_LOOK: Readonly<
  Record<
    NonNullable<SessionView["banner"]>["kind"],
    { readonly tone: "warn" | "info" | "error"; readonly icon: IconName }
  >
> = {
  reconnecting: { tone: "warn", icon: "wifi.slash" },
  failed: { tone: "error", icon: "exclamationmark.triangle" },
  timeout: { tone: "error", icon: "exclamationmark.triangle" },
  "too-many": { tone: "error", icon: "exclamationmark.triangle" },
  archived: { tone: "info", icon: "archivebox" },
  deleted: { tone: "info", icon: "trash" },
  ended: { tone: "info", icon: "checkmark.circle" },
  "too-old": { tone: "info", icon: "clock" },
};

interface HeaderPaneProps {
  readonly store: SessionStore;
  readonly palette: Palette;
  readonly actions: PaneActionsRef;
  readonly hasDrawer: boolean;
  /** The Activity pill (`activity.ts` decides; the shell hands the strings). */
  readonly pillShown: boolean;
  readonly pillLabel: string;
  readonly pillRunning: boolean;
  readonly pillA11y: string;
}

export const HeaderPane = memo(function HeaderPane({
  store,
  palette,
  actions,
  hasDrawer,
  pillShown,
  pillLabel,
  pillRunning,
  pillA11y,
}: HeaderPaneProps): JSX.Element {
  PERF.pane("header");
  const slice = useSlice(store, "header");
  const view = slice.view;
  const status = chatStatus({
    phase: slice.status.phase,
    link: slice.link,
    running: slice.running,
    asking: slice.asking,
    closed: slice.closed,
  });
  const ask =
    slice.sheet.kind === "asking"
      ? askBanner(slice.sheet, slice.askQueued, slice.sheet.origin ?? { kind: "main" })
      : null;
  const banner = view.banner;
  return (
    <>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title={view.title}
        onTitlePress={() => actions.current.controller.beginRename()}
        titleTestID="session-title"
        titleLead={status.dot === null ? null : <HeaderDot palette={palette} dot={status.dot} />}
        titleDim={status.dimTitle}
        titleLabel={titleLabel(view.title, status)}
        left={
          hasDrawer ? (
            <HeaderIcon
              palette={palette}
              testID="session-drawer"
              icon="line.3.horizontal"
              accessibilityLabel="Sessions"
              onPress={() => actions.current.openDrawer()}
            />
          ) : undefined
        }
        right={
          <>
            {/* F1: the Activity pill, between the title and the ring, only
                while something runs or a report is unread (Design 5). With
                "Floating" the button carries it instead, unless VoiceOver
                runs (F23). */}
            {pillShown ? (
              <ActivityBadge
                palette={palette}
                testID="session-activity"
                label={pillLabel}
                running={pillRunning}
                accessibilityLabel={pillA11y}
                onPress={() => actions.current.openActivity()}
              />
            ) : null}
            {/* A1: the context fraction as a small ring next to "…", tap →
                Session info (Design 2). Absent when nothing measured one. */}
            {view.headerContext === null ? null : (
              <ContextRing
                palette={palette}
                percent={view.headerContext.percent}
                onPress={() => actions.current.openInfo()}
                testID="session-header-context"
              />
            )}
            <HeaderIcon
              palette={palette}
              testID="session-menu"
              icon="ellipsis"
              accessibilityLabel="Session menu"
              onPress={() => actions.current.openMenu()}
            />
          </>
        }
        subtitle={
          view.headerFolder === null && view.headerModel === null ? undefined : (
            // `<folder> · <model>` (docs/feat/mobile-header-status.md): no status
            // word — the state is the dot before the title. Tap → Session info,
            // which shows the full path.
            <Pressable
              testID="session-header-status"
              style={styles.headerLines}
              accessibilityRole="button"
              accessibilityLabel={[view.headerFolder?.path, view.headerModel]
                .filter((part) => part !== undefined && part !== null)
                .join(", ")}
              accessibilityHint="Opens Session info"
              onPress={() => actions.current.openInfo()}
            >
              <View style={styles.status}>
                {view.headerFolder === null ? null : (
                  <Text
                    testID="session-header-folder"
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.headerFolder, { color: palette.sec }]}
                  >
                    {view.headerFolder.label}
                  </Text>
                )}
                {view.headerModel === null ? null : (
                  <Text
                    testID="session-header-model"
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    numberOfLines={1}
                    style={[typography.caption, styles.headerModel, { color: palette.sec }]}
                  >
                    {view.headerFolder === null ? view.headerModel : `· ${view.headerModel}`}
                  </Text>
                )}
              </View>
            </Pressable>
          )
        }
      />
      {ask === null ? null : (
        // The parked ask (docs/fix/mobile-ask-surfaces.md): the sheet is down, the
        // ask is still pending. A tap brings it back (the person's intent).
        <AskBanner
          testID="ask-banner"
          palette={palette}
          view={ask}
          onPress={() => actions.current.unparkAsk()}
        />
      )}
      {banner === null ? null : (
        <View testID={`banner-${banner.kind}`}>
          <Banner
            palette={palette}
            {...BANNER_LOOK[banner.kind]}
            body={banner.text}
            {...(view.retry
              ? {
                  action: {
                    label: "Retry",
                    onPress: () => actions.current.retry(),
                    testID: "banner-retry",
                  },
                }
              : view.reopen
                ? {
                    action: {
                      label: "Reopen",
                      onPress: () => actions.current.reopen(),
                      testID: "reopen",
                    },
                  }
                : {})}
          />
        </View>
      )}
    </>
  );
});

const styles = StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 5 },
  headerLines: { alignItems: "center", gap: 4, maxWidth: "100%" },
  // The MODEL gives way first (a far larger shrink factor); the folder then
  // middle-ellipsizes, so its last component stays (owner addendum).
  headerModel: { flexShrink: 100 },
  headerFolder: { fontFamily: MONO, fontSize: 11, lineHeight: 16, flexShrink: 1 },
});
