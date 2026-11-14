/**
 * The camera, as the ONE native seam (11b.2; the pattern `secure-kv.ts` sets for
 * `expo-secure-store`): this is the only file that imports `expo-camera`, so every
 * other module — and every test in `bun test` — stays free of a native import.
 *
 * It WIRES, it does not decide: the permission state → view-model mapping is
 * `camera-access.ts` (pure, tested), the live session's LIFETIME is
 * `scan-session.ts` (pure, tested — fix round 1 finding 1), the texts are those
 * modules' constants, and this hook only performs the step the view names
 * (`ask` → request, `open` → mount the scanner) and reports what the OS said.
 *
 * What the scanner hands back is the RAW decoded string, which is exactly the
 * line `tentacle pair` prints (`deep-link`'s load-bearing check): the app feeds it
 * to the same intake as a paste, so a scan and a paste cannot diverge.
 */
import { CameraView, type PermissionResponse, useCameraPermissions } from "expo-camera";
import { type JSX, useCallback, useEffect, useReducer, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  type CameraView as CameraModel,
  type CameraState,
  cameraStateOf,
  cameraViewFor,
} from "./camera-access.ts";
import type { PairingStage } from "./scan-session.ts";
import { INITIAL_SCAN_SESSION, scanReduce, scannerLive } from "./scan-session.ts";
import type { Palette } from "./theme.ts";

/** What the `Pair` screen needs from the camera (no native type escapes this file). */
export interface PairingCamera {
  /** The pure view-model to render (Scan control, card, copy). */
  readonly view: CameraModel;
  /** Mount the live scanner: true ONLY at the intake (see `scan-session.ts`). */
  readonly scanning: boolean;
  /** The Scan control / denied-card action was tapped. */
  readonly onScan: () => void;
  /**
   * End the live session. The Close control calls it, and so does a paste SUBMIT:
   * a submit that fails to parse keeps the stage at `intake`, so the stage rule
   * alone would let the camera run on over the person's own failure card.
   */
  readonly stop: () => void;
  /** The live preview could not start (a restricted device, a failed session). */
  readonly onMountError: () => void;
  /** One decoded QR string; the screen stops scanning and feeds the intake. */
  readonly onScanned: (text: string) => void;
}

/**
 * The camera's state and actions, for the pairing screen.
 *
 * `denied` is DELIBERATELY not re-requested: iOS resolves a second
 * `requestCameraPermissionsAsync` as `denied` at once, so the tap reveals the
 * card instead (`camera-access.ts` decides that; this hook obeys it).
 *
 * `stage` is the pairing screen's current stage. The session's lifetime is not
 * this hook's to keep (fix round 1 finding 1: it was, and a camera opened by a
 * Scan tap then outlived the intake through `review`/`connecting`/`compare` with
 * no way to close it): the hook only FORWARDS the stage to `scan-session.ts` and
 * mounts the preview while that module says it may be live.
 */
export function usePairingCamera(
  onText: (text: string) => void,
  stage: PairingStage,
): PairingCamera {
  const [permission, requestPermission] = useCameraPermissions();
  const [session, dispatch] = useReducer(scanReduce, INITIAL_SCAN_SESSION);
  const [mountFailed, setMountFailed] = useState(false);
  const state: CameraState = cameraStateOf(permission ?? null, mountFailed);
  const view = cameraViewFor(state, session.tapped);

  // The one rule that keeps the PREVIEW inside the intake: a stage change ends
  // the session, and a move back to `intake` does not revive it.
  useEffect(() => {
    dispatch({ type: "stage", stage });
  }, [stage]);

  const onScan = useCallback(() => {
    dispatch({ type: "tap" });
    switch (view.scan) {
      case "open":
        dispatch({ type: "open" });
        return;
      case "ask":
        // Decision 10: the ONLY moment the OS prompt appears is this tap.
        void requestPermission().then((answer: PermissionResponse) => {
          if (answer.granted) {
            dispatch({ type: "open" });
          }
        });
        return;
      // `explain`: the card is now up (Settings is its own button). `none`: no
      // control is drawn, so this cannot be reached.
      case "explain":
      case "none":
        return;
    }
  }, [view.scan, requestPermission]);

  const onScanned = useCallback(
    (text: string) => {
      // First hit wins and scanning stops (a QR stream repeats the same code
      // many times a second, and a second dispatch would re-parse it).
      dispatch({ type: "scanned" });
      onText(text);
    },
    [onText],
  );

  return {
    view,
    scanning: scannerLive(session, stage),
    onScan,
    stop: useCallback(() => dispatch({ type: "submit" }), []),
    onMountError: useCallback(() => {
      setMountFailed(true);
      dispatch({ type: "mount-error" });
    }, []),
    onScanned,
  };
}

/**
 * The live scanner. Mounted only while the stage permits it (the Close control is
 * the screen's own chrome, `pair-scan-close`): the person who tapped Scan by
 * mistake, or changed their mind and started pasting, must be able to stop the
 * camera without leaving the app.
 */
export function QrScanner({
  palette,
  onScanned,
  onMountError,
}: {
  readonly palette: Palette;
  readonly onScanned: (text: string) => void;
  readonly onMountError: () => void;
}): JSX.Element {
  return (
    <View style={styles.frame}>
      <CameraView
        testID="pair-camera-view"
        style={styles.camera}
        facing="back"
        // Only QR: a barcode-scanning session that looks for every symbology is
        // slower to lock on, and `tentacle pair` prints a QR and nothing else.
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(result) => {
          if (typeof result.data === "string" && result.data !== "") {
            onScanned(result.data);
          }
        }}
        onMountError={onMountError}
      />
      <Text style={[styles.hint, { color: palette.onAccent }]}>
        Point the camera at the QR code `tentacle pair` printed
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 280, justifyContent: "flex-end" },
  camera: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hint: { padding: 12, fontSize: 13, textAlign: "center" },
});
