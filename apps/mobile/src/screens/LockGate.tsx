/**
 * The lock's renderer (docs/feat/mobile-lock.md D5). It DECIDES nothing: the
 * view-model comes from `app-lock.ts`, and this file maps it to elements plus
 * the two side effects React must own (the 1 s heartbeat and the system prompt).
 *
 * Three properties here are load-bearing, not cosmetic:
 * - the content tree is hidden from VoiceOver AND Maestro while locked
 *   (`accessibilityElementsHidden`, `importantForAccessibility="no-hide-descendants"`,
 *   `pointerEvents="none"`), so F14 holds at the accessibility layer, not just
 *   as pixels;
 * - the navigator stays MOUNTED behind the cover (`display: none` would unmount
 *   nothing, but it also keeps drafts and navigation state), so unlocking lands
 *   the person exactly where they were;
 * - the lock renders in a fullScreen `Modal` with no animation, which is what
 *   puts it above a native `formSheet` or an `Alert` (Step 0 fact 3).
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { AppLock, AppLockEvent, LockDelay, LockView } from "../app-lock.ts";
import type { Palette } from "../theme.ts";

/** The heartbeat period: 1 s, as D1's `tick` expects. */
export const HEARTBEAT_MS = 1000;

export interface LockGateDeps {
  /**
   * The lock's ONE instance (D1), created by `App.tsx` and shared with the
   * Settings screen — a second instance would be a second, disagreeing truth
   * about whether the app is locked (the fail-open risk this task is about).
   */
  readonly lock: AppLock;
  /**
   * Ask the system to authenticate. Injected: the component imports no native
   * module, and the test can drive every outcome without a simulator.
   */
  readonly authenticate: () => Promise<
    "success" | "cancel" | "fail" | "lockout" | "not_interactive"
  >;
  /** What this device can do (F2). Injected for the same reason. */
  readonly capability: () => Promise<"unknown" | "ok" | "none">;
  /** The setting once the Keychain read lands (`"loading"` until then: F10). */
  readonly setting: LockDelay | "loading";
  /** Where the lock's own events go (D7's ring). */
  readonly onEvent?: (event: AppLockEvent, view: LockView) => void;
}

export interface LockGateProps extends LockGateDeps {
  readonly palette: Palette;
  readonly children: React.ReactNode;
}

/**
 * The app's ONE lock (D1's state machine + the two side effects). Exported so
 * `App.tsx` wraps the navigator once and nothing else constructs a second one
 * (a second lock would be a second, disagreeing, truth — the fail-open risk).
 */
export function LockGate({
  palette,
  children,
  lock: instance,
  authenticate,
  capability,
  setting,
  onEvent,
}: LockGateProps): JSX.Element {
  const [view, setView] = useState<LockView>(() => instance.view());
  // Re-entrancy guard: an evaluation already running must not be raised twice.
  const asking = useRef(false);

  // The sink is kept in a ref so the effect that fires on every prompt does not
  // depend on a caller-supplied closure identity.
  const eventSink = useRef(onEvent);
  eventSink.current = onEvent;

  const dispatch = useCallback(
    (event: AppLockEvent): LockView => {
      const next = instance.dispatch(event);
      setView(next);
      eventSink.current?.(event, next);
      return next;
    },
    [instance],
  );

  // Launch: lock first (`launch` covers the very first frame), then read what
  // this device can do. The SETTING arrives from `App`'s Keychain read and
  // dispatches `loaded` when it lands (see the effect below).
  useEffect(() => {
    dispatch({ type: "launch" });
    void capability().then((value) => {
      dispatch({ type: "capability", capability: value });
    });
  }, [dispatch, capability]);

  // The setting: `loading` keeps the cover up (F10); a decided delay applies.
  useEffect(() => {
    if (setting !== "loading") {
      dispatch({ type: "loaded", setting });
    }
  }, [dispatch, setting]);

  // AppState → the reducer. `inactive` is passed through and does nothing (F6);
  // `background` marks and `active` judges, exactly as the plan's table says.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" || state === "inactive" || state === "background") {
        dispatch({ type: "appState", state });
      }
    });
    return () => subscription.remove();
  }, [dispatch]);

  // The heartbeat (F7): a 1 s tick that only advances while the app is active.
  // iOS stops JS on suspension, so the last tick is the moment to measure from.
  useEffect(() => {
    const id = setInterval(() => {
      dispatch({ type: "tick" });
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [dispatch]);

  // The prompt: raise it once per episode, only while active, and ACK it before
  // the evaluation starts — the prompt's own inactive → active must not re-arm it.
  useEffect(() => {
    if (!view.prompt || asking.current) {
      return;
    }
    asking.current = true;
    dispatch({ type: "prompted" });
    void authenticate()
      .then((result) => {
        dispatch({ type: "authResult", result });
      })
      .finally(() => {
        asking.current = false;
      });
  }, [view.prompt, dispatch, authenticate]);

  const unlockPressed = useCallback(() => {
    if (asking.current) {
      return;
    }
    asking.current = true;
    void authenticate()
      .then((result) => {
        dispatch({ type: "authResult", result });
      })
      .finally(() => {
        asking.current = false;
      });
  }, [dispatch, authenticate]);

  const locked = view.cover === "lock";

  return (
    <View style={styles.root}>
      <View
        style={styles.root}
        // F14: while locked, NOTHING under the cover is reachable — not by a tap,
        // not by VoiceOver, not by Maestro's accessibility queries.
        pointerEvents={locked ? "none" : "auto"}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
        testID={locked ? "locked-content" : "app-content"}
      >
        {children}
      </View>
      <Modal
        visible={locked}
        // `fullScreen` + no animation: above a native formSheet or Alert, and on
        // screen before the switcher's snapshot (Step 0 fact 3, F13).
        presentationStyle="fullScreen"
        animationType="none"
        // The lock is not dismissible: only a successful auth opens it, so
        // Android's hardware back does nothing here.
        onRequestClose={() => {}}
      >
        <View style={[styles.lock, { backgroundColor: palette.groupedBackground }]}>
          <Text testID="lock-screen" style={[styles.hidden, { color: palette.label }]}>
            tentacle is locked
          </Text>
          <Text style={[styles.sub, { color: palette.secondaryLabel }]}>
            Unlock to see your sessions
          </Text>
          {view.notice === "no-passcode" ? (
            <Text testID="lock-notice" style={[styles.sub, { color: palette.secondaryLabel }]}>
              This iPhone has no passcode, so tentacle cannot lock. Add one in Settings → Face ID &
              Passcode.
            </Text>
          ) : (
            <Pressable
              testID="lock-unlock"
              accessibilityRole="button"
              onPress={unlockPressed}
              style={[styles.button, { backgroundColor: palette.accent }]}
            >
              <Text style={[styles.buttonText, { color: palette.onAccent }]}>Unlock</Text>
            </Pressable>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  lock: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  hidden: { fontSize: 22, fontWeight: "600", marginBottom: 8 },
  sub: { fontSize: 14, textAlign: "center", marginBottom: 24 },
  button: { borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  buttonText: { fontSize: 16, fontWeight: "600" },
});
