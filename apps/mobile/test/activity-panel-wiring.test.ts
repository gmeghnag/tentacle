/**
 * The Activity panel's presentation wiring (docs/feat/mobile-activity-panel.md),
 * pinned where Bun can reach it. `screens/ActivitySheet.tsx` and `ui/ActivityRow.tsx`
 * are `.tsx` (unimportable from Bun: React Native's sources are Flow), so this
 * pins the STRUCTURE from the source — the `hub-tap-wiring.test.ts` pattern. What
 * the sheet does with a drag is `activity-panel.test.ts`'s; this is only that the
 * sheet asks it, and that the gate/close the Design names are the ones wired.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const SHEET = code(read("src", "screens", "ActivitySheet.tsx"));
const ROW = code(read("src", "ui", "ActivityRow.tsx"));
const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));
const CONTROLLER = code(read("src", "session-screen-controller.ts"));

describe("the sheet is a JS bottom sheet, not a native page sheet (Design 2)", () => {
  test("no `pageSheet`, no native slide: the Modal is transparent and motionless", () => {
    // The owner's report: a `pageSheet` has one (large) detent and iOS's own
    // dismiss resistance. Both go away with the presentation.
    expect(SHEET).not.toContain("pageSheet");
    expect(SHEET).toContain("transparent");
    expect(SHEET).toContain('animationType="none"');
    expect(SHEET).toContain("Animated.View");
  });

  test("the height is an `Animated.Value`, so the drag can drive it", () => {
    expect(SHEET).toContain("useRef(new Animated.Value(0))");
  });

  test("Reduce Motion is honoured by the motion itself", () => {
    expect(SHEET).toContain("reduceMotion");
    expect(SHEET).toContain("Animated.timing(");
  });

  test("a drag is the pure module's: `panelDrag` while moving, `panelRelease` on release", () => {
    expect(SHEET).toContain("panelDrag(");
    expect(SHEET).toContain("panelRelease(");
    expect(SHEET).toContain("panelDetents(");
  });

  test("a re-measured content only moves a sheet resting at `low`", () => {
    // A row ending/arriving re-settles the low detent; a sheet dragged up to
    // `tall` stays where the person put it (`panelFollowsContent`, pure).
    expect(SHEET).toContain("panelFollowsContent(");
    expect(SHEET).toContain("onContentSizeChange");
  });

  test("the pan is the header's only: the list keeps its own gesture (Owner Q2)", () => {
    // `panHandlers` spread on the header, and nowhere else.
    expect(SHEET.match(/pan\.panHandlers/g)?.length).toBe(1);
    const header = SHEET.slice(SHEET.indexOf("function Header"), SHEET.indexOf("export function"));
    expect(header).toContain("...pan");
  });
});

describe("every close path converges on one handler (Design 5)", () => {
  test("the scrim, the release and Android's back all call the sheet's ONE `close`", () => {
    // The scrim's own press...
    const scrim = SHEET.slice(SHEET.indexOf('testID="activity-scrim"'));
    expect(scrim.slice(0, 400)).toContain("onPress={close}");
    // ...Android's back (the Modal's request)...
    expect(SHEET).toContain("onRequestClose={close}");
    // ...and the release's "close" verdict, which animates out THEN closes.
    expect(SHEET).toContain('if (rest === "close")');
    expect(SHEET).toContain("closeRef.current()");
  });

  test("a close finishes on ANY end of its motion, never only on a finished spring", () => {
    // An interrupted spring ends with `{finished:false}`: anything else touching
    // the same `Animated.Value` mid-close does it — a row arriving (the content
    // re-measures), a tap on a row (`focus` → the detent effect), a re-grab of
    // the header (`height.setValue`). A continuation gated on `finished` then
    // never runs, so `closing` stayed `true`, every later close returned at its
    // guard and the sheet was a modal overlay nobody could dismiss.
    const at = SHEET.indexOf("(to: number, done?: () => void) => {");
    expect(at).toBeGreaterThan(-1);
    const body = SHEET.slice(at, SHEET.indexOf("[height, reduceMotion]", at));
    expect(body).toContain("done?.()");
    expect(body).not.toContain("if (finished)");
  });

  test("nothing re-opens a sheet whose close is in flight", () => {
    // Both effects that animate the sheet unbidden (the open/detent one and the
    // content-follow one) stand down while `closing`: otherwise the close's
    // spring is interrupted and the sheet springs back open first.
    const head = (marker: string) => {
      const at = SHEET.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      return SHEET.slice(SHEET.lastIndexOf("useEffect(", at), at);
    };
    expect(head('animateTo(wanted === "tall"')).toContain("closing.current");
    expect(head("panelFollowsContent(shown, lastLow.current")).toContain("closing.current");
    // ...and the third trigger the Review named is the header's own grab: it
    // drives `height.setValue`, so it must not claim a pan on a closing sheet.
    const grab = SHEET.slice(SHEET.indexOf("onMoveShouldSetPanResponder"));
    expect(grab.slice(0, 200)).toContain("!closing.current");
  });

  test("the screen's own close clears the panel, the focus AND the controller's detail", () => {
    const at = SCREEN.indexOf("const closeActivity = ");
    expect(at).toBeGreaterThan(-1);
    const body = SCREEN.slice(at, SCREEN.indexOf("};", at));
    expect(body).toContain("setActivityOpen(false)");
    expect(body).toContain("setActivityFocus(null)");
    expect(body).toContain("controller.closeDetail()");
    // The sheet is handed THIS handler, not a second inline copy.
    const at2 = SCREEN.indexOf("<ActivitySheet");
    const props = SCREEN.slice(at2, SCREEN.indexOf("/>", at2));
    expect(props).toContain("onClose={closeActivity}");
  });
});

describe("never an empty panel (Design 1 / Owner Q3)", () => {
  test("the hub's open path asks `panelOpensFor`", () => {
    const at = SCREEN.indexOf("const openActivity = () => {");
    expect(at).toBeGreaterThan(-1);
    expect(SCREEN.slice(at, SCREEN.indexOf("};", at))).toContain("panelOpensFor(");
  });

  test("an effect closes the panel on `panelAutoClose`", () => {
    expect(SCREEN).toContain("panelAutoClose(activityVm, activityFocus)");
  });

  test("a detail's own keyboard is dodged inside the sheet (a detail opens at `tall`)", () => {
    expect(SHEET).toContain("KeyboardAvoidingView");
    // ...and the detent a detail wants is the pure module's, not a literal.
    expect(SHEET).toContain("panelDetentFor(focus)");
  });

  test("two opens in one frame are one state: the last focus wins (Design, failure modes)", () => {
    // The hub's open resets the focus to the list...
    const hub = SCREEN.indexOf("const openActivity = () => {");
    const hubBody = SCREEN.slice(hub, SCREEN.indexOf("\n  };", hub));
    expect(hubBody).toContain("focusActivity(null)");
    expect(hubBody).toContain("setActivityOpen(true)");
    // ...and an agent card's open sets ITS focus, then opens: both paths write
    // the same two state cells, so there is no second panel state to disagree.
    const card = SCREEN.indexOf("onOpen: () => {");
    expect(card).toBeGreaterThan(-1);
    const cardBody = SCREEN.slice(card, SCREEN.indexOf("},", card));
    expect(cardBody).toContain('focusActivity({ kind: "child", id: child })');
    expect(cardBody).toContain("setActivityOpen(true)");
    // One panel, one open flag: nothing else in the screen owns a second one.
    expect(SCREEN.match(/setActivityOpen\(true\)/g)?.length).toBe(2);
  });
});

describe("the row anatomy (Design 3)", () => {
  test("the sheet draws rows through `ActivityRow`, not a generic `Row`", () => {
    expect(SHEET).toContain("<ActivityRow");
    // The empty line is still a dimmed `Row` (it is not an activity row).
    expect(SHEET).toContain("<Row palette={palette} title={group.empty}");
  });

  test("the header carries the count", () => {
    expect(SHEET).toContain("`Activity · ${count}`");
    expect(SHEET).toContain("view.count + view.unread");
  });

  test("the trailing ■ needs two taps: the arm is `activity-panel.ts`'s", () => {
    expect(ROW).toContain('"■ Stop"');
    expect(ROW).toContain("armed");
    // The armed state is never computed in the component: it is handed in.
    expect(ROW).not.toContain("stopTap(");
    expect(SHEET).toContain("stopArmed(arm, row.id, now)");
  });
});

describe("a row Stop has its own controller entry (Design 4)", () => {
  test("`stopRow` kills by id without opening a detail", () => {
    const at = CONTROLLER.indexOf("async stopRow(kind, id) {");
    expect(at).toBeGreaterThan(-1);
    const body = CONTROLLER.slice(at, CONTROLLER.indexOf("\n    },", at));
    expect(body).toContain("killSubagent");
    expect(body).toContain("killJob");
    expect(body).toContain("killChildOutcome");
    expect(body).toContain("killJobOutcome");
    // Opening a detail is what a ROW Stop must not do.
    expect(body).not.toContain("openChild(");
    expect(body).not.toContain("openJob(");
  });

  test("the screen's inline Stop is the two-tap arm, and the detail keeps its Alert", () => {
    const at = SCREEN.indexOf("const stopRow = (kind");
    expect(at).toBeGreaterThan(-1);
    const body = SCREEN.slice(at, SCREEN.indexOf("\n  };", at));
    expect(body).toContain("stopTap(arm, id, Date.now())");
    expect(body).toContain("if (tap.fire)");
    expect(body).toContain("controller.stopRow(kind, id)");
    // The detail's Stop still asks first (F17).
    const confirm = SCREEN.slice(SCREEN.indexOf("const confirmStop = () => {"));
    expect(confirm.slice(0, 700)).toContain("Alert.alert(");
  });
});
