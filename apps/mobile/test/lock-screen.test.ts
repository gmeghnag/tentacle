/**
 * `lock-screen.ts` — the Lock screen's copy (docs/feat/mobile-ui-polish.md
 * Design 5 "Lock"): the button names only an enrolled sensor, and the footnote
 * states the delay actually chosen (none for `never` / still loading).
 */
import { describe, expect, test } from "bun:test";
import { biometryFrom, lockScreenView } from "../src/lock-screen.ts";

describe("biometryFrom", () => {
  test("an enrolled face is Face ID, an enrolled finger is Touch ID", () => {
    expect(biometryFrom({ enrolled: true, face: true, touch: false })).toBe("face");
    expect(biometryFrom({ enrolled: true, face: false, touch: true })).toBe("touch");
  });

  test("sensor present but nothing enrolled names no sensor", () => {
    expect(biometryFrom({ enrolled: false, face: true, touch: false })).toBe("none");
    expect(biometryFrom({ enrolled: false, face: false, touch: true })).toBe("none");
  });

  test("enrolled with no known sensor is none", () => {
    expect(biometryFrom({ enrolled: true, face: false, touch: false })).toBe("none");
  });
});

describe("lockScreenView", () => {
  test("Face ID: the mockup's copy, with Use Passcode", () => {
    expect(lockScreenView("5m", "face")).toEqual({
      title: "tentacle is locked",
      subtitle: "Your sessions stay hidden, in the app switcher too.",
      unlockLabel: "Unlock with Face ID",
      unlockIcon: "faceid",
      showPasscode: true,
      footnote: "Locks after 5 minutes in the background. Change it in Settings.",
    });
  });

  test("Touch ID (iPhone SE) never says Face ID", () => {
    const view = lockScreenView("5m", "touch");
    expect(view.unlockLabel).toBe("Unlock with Touch ID");
    expect(view.unlockIcon).toBe("touchid");
    expect(view.showPasscode).toBe(true);
  });

  test("no sensor (or not yet known): plain Unlock, no separate passcode button", () => {
    for (const biometry of ["none", "unknown"] as const) {
      const view = lockScreenView("5m", biometry);
      expect(view.unlockLabel).toBe("Unlock");
      expect(view.unlockIcon).toBe("lock.fill");
      expect(view.showPasscode).toBe(false);
    }
  });

  test("the footnote follows the setting", () => {
    expect(lockScreenView("immediately", "face").footnote).toBe(
      "Locks as soon as you leave tentacle. Change it in Settings.",
    );
    expect(lockScreenView("1h", "face").footnote).toBe(
      "Locks after 1 hour in the background. Change it in Settings.",
    );
    expect(lockScreenView("never", "face").footnote).toBeNull();
    expect(lockScreenView("loading", "face").footnote).toBeNull();
  });
});
