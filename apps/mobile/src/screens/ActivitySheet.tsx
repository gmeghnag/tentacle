/**
 * The Activity panel (docs/feat/mobile-chrome.md Design 5 slice S8; the
 * low-detent bottom sheet of docs/feat/mobile-activity-panel.md): everything that
 * runs beside the conversation, one band per group, running first — Sub-agents,
 * Shell jobs, Finished, Scheduled (the wakes' count + the soonest; a tap opens
 * Session info's SCHEDULED WAKES, `onScheduled`). Every row opens its detail
 * (S9): a child's (`SubagentDetail` — live steps, message, Stop; or a Finished
 * child's report) or a shell job's (`JobDetail`).
 *
 * The presentation is OURS, not a native page sheet (mobile-activity-panel
 * Design 2): a transparent `Modal` holding a light scrim and an `Animated` sheet
 * anchored to the bottom. Its height is a detent from `activity-panel.ts` — the
 * low one fits the content, the tall one only exists when the rows overflow —
 * and the grabber + header carry the ONLY vertical pan (the list keeps its
 * scroll: dragging a row never moves the sheet). A downward flick closes from
 * either detent with no resistance; a slow drag under the close band closes too;
 * a tap on the scrim closes; every one of those calls the SAME `onClose`.
 *
 * Render only (AGENTS §7): the groups, rows and labels are `activity.ts`'s, the
 * detail is `subagent-detail.ts`'s `sheetDetail`, the detents/release/gates are
 * `activity-panel.ts`'s; WHICH row is armed for a Stop is the screen's.
 */
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  PANEL_HEIGHT,
  PANEL_SPRING,
  type PanelDetents,
  type StopArm,
  panelDetentFor,
  panelDetents,
  panelDrag,
  panelFollowsContent,
  panelRelease,
  stopArmed,
} from "../activity-panel.ts";
import { type ActivityGroup, type ActivityView, oneLine } from "../activity.ts";
import type { ChildAction, JobAction } from "../session-screen-controller.ts";
import type { ActivityFocus, SheetDetail } from "../subagent-detail.ts";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, radius, typography } from "../theme.ts";
import { ActivityRow } from "../ui/ActivityRow.tsx";
import { BandSection } from "../ui/BandSection.tsx";
import { Row } from "../ui/Row.tsx";
import { Text } from "../ui/Text.tsx";
import { JobDetail } from "./JobDetail.tsx";
import { SubagentDetail } from "./SubagentDetail.tsx";

export interface ActivitySheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
  readonly view: ActivityView;
  /** The open detail (`sheetDetail`); `null`: the list. */
  readonly detail: SheetDetail;
  /** WHICH detail was asked for — the detent's rule (`panelDetentFor`). */
  readonly focus: ActivityFocus;
  /** The screen's 1 s clock: the elapsed times and the Stop arm's window. */
  readonly now: number;
  readonly child: ChildAction | null;
  readonly job: JobAction | null;
  /** Open a row's detail, or go back to the list (`null`). */
  readonly onFocus: (focus: ActivityFocus) => void;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
  /** Stop the open child or job — the screen confirms first (F17). */
  readonly onStop: () => void;
  /** A row's inline ■: already confirmed by its two taps (Design 4). */
  readonly onStopRow: (kind: "child" | "job", id: string) => void;
  /** The armed row, and when it armed (`activity-panel.ts`). */
  readonly arm: StopArm;
  /** A row Stop's refusal, by row id (cleared by the next activity update). */
  readonly stopNotices: Readonly<Record<string, string>>;
  readonly onRefreshJob: () => void;
  /** The Scheduled row: close this sheet, open Session info at SCHEDULED WAKES. */
  readonly onScheduled: () => void;
  /** Absent: the open report's row is not in the transcript. */
  readonly onShow?: () => void;
  readonly onLink: (href: string) => void;
  readonly onClose: () => void;
  /** Reduce Motion: no spring, a short timing (Design 2). */
  readonly reduceMotion: boolean;
}

function Group({
  palette,
  group,
  arm,
  now,
  stopNotices,
  onOpen,
  onStopRow,
  onScheduled,
}: {
  readonly palette: Palette;
  readonly group: ActivityGroup;
  readonly arm: StopArm;
  readonly now: number;
  readonly stopNotices: Readonly<Record<string, string>>;
  readonly onOpen: (focus: ActivityFocus) => void;
  readonly onStopRow: (kind: "child" | "job", id: string) => void;
  readonly onScheduled: () => void;
}): JSX.Element {
  if (group.rows.length === 0 && group.empty !== null) {
    return (
      <BandSection palette={palette} title={group.title} onSheet testID={`activity-${group.kind}`}>
        <Row palette={palette} title={group.empty} dimmed first onSheet />
      </BandSection>
    );
  }
  return (
    <BandSection palette={palette} title={group.title} onSheet testID={`activity-${group.kind}`}>
      {group.rows.map((row, i) => {
        const notice = stopNotices[row.id];
        return (
          <ActivityRow
            key={row.key}
            palette={palette}
            row={row}
            first={i === 0}
            armed={stopArmed(arm, row.id, now)}
            {...(notice === undefined ? {} : { notice: oneLine(notice) })}
            onPress={() =>
              row.kind === "scheduled"
                ? onScheduled()
                : onOpen({ kind: row.kind === "job" ? "job" : "child", id: row.id })
            }
            {...(row.kind === "finished" || row.kind === "scheduled"
              ? {}
              : { onStop: () => onStopRow(row.kind === "job" ? "job" : "child", row.id) })}
          />
        );
      })}
    </BandSection>
  );
}

/** The sheet's own header: the grabber, "Activity · N", and the drag it carries. */
function Header({
  palette,
  label,
  pan,
}: {
  readonly palette: Palette;
  readonly label: string;
  readonly pan: ReturnType<typeof PanResponder.create>["panHandlers"];
}): JSX.Element {
  return (
    <View testID="activity-panel-header" style={styles.header} {...pan}>
      <View style={[styles.grabber, { backgroundColor: palette.dash }]} />
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.headline, { color: palette.label }]}
      >
        {label}
      </Text>
    </View>
  );
}

export function ActivitySheet({
  palette,
  visible,
  view,
  detail,
  focus,
  now,
  child,
  job,
  onFocus,
  onDraft,
  onSend,
  onStop,
  onStopRow,
  arm,
  stopNotices,
  onRefreshJob,
  onScheduled,
  onShow,
  onLink,
  onClose,
  reduceMotion,
}: ActivitySheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  // The visible height of the sheet, measured from the screen's bottom.
  const [shown, setShown] = useState(0);
  const [content, setContent] = useState(0);
  // The screen's height comes from the sheet's own layout: it is the Modal's full
  // frame, so it is the one measurement that needs no dimension API.
  const [screen, setScreen] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  // What is DRAWN: the value, never below 0 (`PANEL_HEIGHT` — a close's spring
  // undershoots 0, and a negative height lays the sheet out at full size).
  const drawn = useMemo(() => height.interpolate(PANEL_HEIGHT), [height]);
  const detents: PanelDetents = useMemo(
    () =>
      panelDetents({
        contentHeight: content,
        screenHeight: screen,
        topInset: insets.top,
        bottomInset: insets.bottom,
      }),
    [content, screen, insets.top, insets.bottom],
  );
  // The detent this opening wants: a detail (message field + keyboard) needs the
  // tall one; the list starts at `low`.
  const wanted = panelDetentFor(focus);
  // A closed sheet is not measured: the detents are a fact of an open panel.
  const settled = detail === null ? detents.low : detents.tall;
  const animateTo = useCallback(
    (to: number, done?: () => void) => {
      setShown(to);
      if (reduceMotion) {
        Animated.timing(height, { toValue: to, duration: 150, useNativeDriver: false }).start(() =>
          done?.(),
        );
        return;
      }
      Animated.spring(height, {
        toValue: to,
        useNativeDriver: false,
        ...PANEL_SPRING,
        // ANY end runs the continuation, not only a `finished` spring: an
        // interrupted one ends with `{finished:false}` (anything else touching
        // this `Animated.Value` stops it — a re-measure, a re-grab, a retarget),
        // and a close whose continuation never ran stayed latched, so every
        // later close returned at its guard: the sheet became a modal overlay
        // nobody could dismiss. The close intent wins over the interruption.
      }).start(() => done?.());
    },
    [height, reduceMotion],
  );
  // The close is ONE door (Design 5): the scrim, the swipe, Android's back and the
  // auto-close all end here. The `Modal` stays mounted through the animation, so
  // a flicked sheet is SEEN leaving instead of vanishing.
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) {
      return;
    }
    closing.current = true;
    animateTo(0, () => {
      closing.current = false;
      onClose();
    });
  }, [animateTo, onClose]);
  const closeRef = useRef(close);
  closeRef.current = close;
  // Opening: the sheet rises from 0 to its detent (or jumps there under Reduce
  // Motion). A detail opened on an already-open sheet moves to `tall`, and a
  // detail's "back" returns the list to `low`.
  // ...and neither effect animates the sheet while a close is in flight: it
  // would STOP the close's spring and spring the sheet back open.
  useEffect(() => {
    if (!visible || screen === 0 || closing.current) {
      return;
    }
    animateTo(wanted === "tall" ? detents.tall : detents.low);
  }, [visible, screen, wanted, detents.low, detents.tall, animateTo]);
  // The measured content re-settles the LOW detent as rows come and go, but only
  // while the sheet is resting there: one dragged up to the tall detent stays
  // where the person put it (`panelFollowsContent`).
  const lastLow = useRef(0);
  useEffect(() => {
    if (!visible || screen === 0 || detail !== null || shown === 0 || closing.current) {
      return;
    }
    if (panelFollowsContent(shown, lastLow.current, detents.low)) {
      animateTo(detents.low);
    }
    lastLow.current = detents.low;
  }, [visible, screen, detail, detents.low, shown, animateTo]);
  const panStart = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        // The header claims a pan on ANY vertical move: it is not a scroller, so
        // there is no gesture to lose (a row's list keeps its own — Design 2).
        // ...except on a sheet already leaving: a grab there would re-target the
        // very value the close is animating, springing it back open.
        onMoveShouldSetPanResponder: (_e, g) => !closing.current && Math.abs(g.dy) > 4,
        onPanResponderGrant: () => {
          panStart.current = shown;
        },
        onPanResponderMove: (_e, g) => {
          height.setValue(panelDrag(panStart.current, g.dy, detents));
        },
        onPanResponderRelease: (_e, g) => {
          const shownNow = panelDrag(panStart.current, g.dy, detents);
          const rest = panelRelease(shownNow, g.vy, detents);
          if (rest === "close") {
            closeRef.current();
            return;
          }
          animateTo(rest === "tall" ? detents.tall : detents.low);
        },
        onPanResponderTerminate: () => {
          animateTo(shown);
        },
      }),
    [shown, detents, animateTo, height],
  );
  const count = view.count + view.unread;
  const label = count === 0 ? "Activity" : `Activity · ${count}`;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View
        style={styles.root}
        onLayout={(e) => setScreen(Math.round(e.nativeEvent.layout.height))}
      >
        <Pressable
          testID="activity-scrim"
          accessibilityLabel="Close activity"
          onPress={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
        />
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.avoider}
        >
          <Animated.View
            testID="activity-sheet"
            style={[
              styles.panel,
              { height: drawn, backgroundColor: palette.bg, paddingBottom: insets.bottom },
            ]}
          >
            <Header palette={palette} label={label} pan={pan.panHandlers} />
            {detail === null ? (
              <ScrollView
                testID="activity-scroll"
                showsVerticalScrollIndicator
                // A short list cannot scroll: the sheet already fits it.
                scrollEnabled={detents.scrollable || shown < detents.tall}
                contentContainerStyle={styles.list}
                onContentSizeChange={(_w, h) => setContent(Math.round(h))}
              >
                {view.empty === null ? null : (
                  <BandSection palette={palette} title="Running" onSheet testID="activity-empty">
                    <Row palette={palette} title={view.empty} dimmed first onSheet />
                  </BandSection>
                )}
                {view.groups.map((group) => (
                  <Group
                    key={group.kind}
                    palette={palette}
                    group={group}
                    arm={arm}
                    now={now}
                    stopNotices={stopNotices}
                    onOpen={onFocus}
                    onStopRow={onStopRow}
                    onScheduled={onScheduled}
                  />
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            ) : detail.kind === "job" ? (
              <JobDetail
                palette={palette}
                view={detail.view}
                action={job}
                onRefresh={onRefreshJob}
                onStop={onStop}
                onBack={() => onFocus(null)}
              />
            ) : (
              <SubagentDetail
                palette={palette}
                view={detail.view}
                report={detail.report}
                action={child}
                onDraft={onDraft}
                onSend={onSend}
                onStop={onStop}
                {...(onShow === undefined ? {} : { onShow })}
                onLink={onLink}
                onBack={() => onFocus(null)}
              />
            )}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  avoider: { justifyContent: "flex-end" },
  panel: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 10,
    gap: 6,
  },
  grabber: { width: SIZE.grabberWidth, height: SIZE.grabberHeight, borderRadius: 3, opacity: 0.45 },
  list: { paddingBottom: 12 },
});
