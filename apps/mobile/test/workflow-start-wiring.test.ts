/**
 * The Start-a-workflow wiring (docs/feat/workflows-ui.md D6, slice 5b): read from
 * the sources, like `workflow-screens-wiring.test.ts`, because these are exactly
 * the rules a renderer harness cannot see (AGENTS §7).
 *
 * I know X for sure: the catalogue and the start go through the ONE session path
 * (`RUNTIMES.controller` → `open`, never `reopen`), a screen is a dumb renderer,
 * and a `run` step's command is what an approval asks about — so it is never cut.
 * My current hypothesis is Y: every one of those is visible as a literal in the
 * source. My next cheapest test is Z: these assertions.
 */
import { describe, expect, test } from "bun:test";

const APP = await Bun.file(`${import.meta.dir}/../App.tsx`).text();
const ROUTES = await Bun.file(`${import.meta.dir}/../src/routes.ts`).text();
const SCREEN = await Bun.file(`${import.meta.dir}/../src/screens/WorkflowStart.tsx`).text();
const RUNS = await Bun.file(`${import.meta.dir}/../src/screens/WorkflowRuns.tsx`).text();
const SESSION = await Bun.file(`${import.meta.dir}/../src/screens/SessionScreen.tsx`).text();
const CARD = await Bun.file(`${import.meta.dir}/../src/ui/AskCard.tsx`).text();
const PILL = await Bun.file(`${import.meta.dir}/../src/ui/PillButton.tsx`).text();
const BANNER = await Bun.file(`${import.meta.dir}/../src/ui/AskBanner.tsx`)
  .text()
  .catch(() => "");
const flow = (name: string) => Bun.file(`${import.meta.dir}/../e2e/flows/${name}.yaml`).text();
const SHOT_FLOW = await flow("_shot");
const LANDING_FLOW = await flow("46-workflow-landing");
const LANDING_SHOTS_FLOW = await flow("46b-workflow-landing-shots");

/** The text of `start`'s block: up to the first line that closes it at column 0. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("the route is registered and plain", () => {
  test("the stack has a WorkflowStart screen, declared in the route types", () => {
    expect(APP).toContain('name="WorkflowStart"');
    expect(ROUTES).toContain("WorkflowStart: WorkflowStartRoute");
    expect(ROUTES).toContain("export interface WorkflowStartRoute");
  });

  test("a plain push screen: no <Modal>, no sheet route, headerShown false", () => {
    const block = between(APP, 'name="WorkflowStart"', "</Stack.Screen>");
    expect(block).not.toContain("<Modal");
    expect(block).not.toContain('navigate("Sheet"');
    expect(block).toContain("headerShown: false");
  });
});

describe("the route reuses the ONE session path", () => {
  const route = between(APP, "function WorkflowStartRoute", "\nfunction ");

  test("it attaches through RUNTIMES and never with `reopen` (§7 archive rule)", () => {
    expect(route).toContain("RUNTIMES.controller(link.client)");
    expect(route).toContain("runtime.open(id)");
    expect(route).not.toContain("reopen");
  });

  test("a session another screen follows is borrowed, never left from here", () => {
    expect(route).toContain("borrowed: runtime.follows(sessionId)");
  });

  test("it never reads the catalogue or starts a run itself — only the controller", () => {
    expect(route).not.toContain("workflowCatalogue");
    expect(route).not.toContain("workflow({");
    expect(route).toContain("createWorkflowStartController");
    expect(route).toContain("controller.beginStart()");
  });

  test("a start opens the run screen it names", () => {
    expect(route).toContain("onOpenRun");
    expect(APP).toContain('navigate("WorkflowRun"');
  });
});

describe("the screen is a dumb renderer", () => {
  test("it sends nothing on the wire itself", () => {
    expect(SCREEN).not.toContain("workflowCatalogue");
    expect(SCREEN).not.toContain("workflow(");
    expect(SCREEN).not.toContain("useEffect");
  });

  test("a `run` step's command is drawn verbatim — never line-capped", () => {
    const detail = between(SCREEN, "function Detail", "\nexport function ");
    expect(detail).toContain("command");
    expect(detail).toContain("workflow-start-step-");
    // The item's one summary line IS capped (landing-v2 D3); the detail never.
    expect(detail).not.toContain("numberOfLines");
    expect(detail).not.toContain("ellipsizeMode");
  });

  test("it draws the catalogue, the folder, a broken row's errors and the form", () => {
    for (const id of [
      "workflow-start-dir",
      "workflow-start-banner",
      "workflow-start-row-",
      "workflow-start-broken-",
      "workflow-start-errors-",
      "workflow-start-detail",
      "workflow-start-step-",
      "workflow-start-input-",
      "workflow-start-run",
      "workflow-start-unsupported",
      "workflow-start-unavailable",
    ]) {
      expect(SCREEN).toContain(id);
    }
  });

  test("an item's actions come from the view-model, and a dimmed one sends nothing", () => {
    const item = between(SCREEN, "function Item", "function Landing");
    expect(item).toContain("item.actions.map");
    expect(item).toContain("testID={`workflow-item-${action.id}-${item.name}`}");
    expect(item).toContain(
      "action.enabled ? screen.onAct(action.id, item.key) : screen.onDimmed()",
    );
    expect(SCREEN).toContain("landingItems(");
    // The delete question is inline, never a native alert.
    expect(SCREEN).toContain("workflow-delete-confirm-");
    expect(SCREEN).toContain("workflow-delete-cancel-");
    expect(SCREEN).not.toContain("Alert");
  });

  test("square bands: the list has no rounded card", () => {
    const band = between(SCREEN, "  band: {", "},");
    expect(band).not.toContain("borderRadius");
  });
});

describe("the hub lands on the workflow list (mobile-workflows-landing D7)", () => {
  const route = between(APP, "function WorkflowStartRoute", "\nfunction ");

  test("the hub's Workflows entry navigates to the landing, not the run list", () => {
    const hub = between(APP, "onOpenWorkflows={() =>", "onOpenArtifacts=");
    expect(hub).toContain('navigate("WorkflowStart"');
    expect(hub).not.toContain("WorkflowRuns");
  });

  test("`Recent runs` leads to the run list, which has no Start", () => {
    expect(APP).toContain("onRecent={() =>");
    expect(APP).toContain('navigate("WorkflowRuns"');
    expect(RUNS).not.toContain("Start a workflow");
  });

  test("the sheet is never answered here, and a re-render never rebuilds the controller", () => {
    expect(route).toContain("SESSION_SCREENS.get(sessionKey(computerId, sessionId))");
    expect(route).toContain("askSourceFromSheet({");
    expect(route).toContain("controller?.setOffline(offline)");
    expect(route).toContain("}, [computerId, sessionId]);");
    expect(route).toContain('playHaptic("light")');
    expect(route).not.toContain("workflowApprove");
    expect(route).not.toContain("workflowDelete");
  });
});

describe("the run list watches the link (fix/e2e-reds-2611)", () => {
  test("a change of the link triggers a read, so a dropped link reads as offline", () => {
    const hook = between(APP, "function useWorkflowRuns", "\n}\n");
    expect(hook).toContain("link.client.onLinkStatus(() => listener())");
    expect(hook).toContain("link.client.onSessionWorkflows(() => listener())");
  });
});

describe("the ask is the banner under the header (mobile-workflows-landing-v2)", () => {
  const route = between(APP, "function WorkflowStartRoute", "\nfunction ");

  test("the Session screen presents a sheet by `reviewed` too", () => {
    // Mutation: drop the fourth argument → red.
    expect(SESSION).toMatch(
      /askPresentable\([^;]*?topRunId,\s*workflowsTop,\s*state\.sheet\.reviewed,?\s*\)/,
    );
  });

  test("the landing's source can bring the sheet up and count the queue", () => {
    const source = between(route, "askSourceFromSheet({", "}),");
    expect(source).toContain("unpark: () => screen.sheet().unpark()");
    expect(source).toContain("queued: () => screen.sheet().queued");
    expect(route).toContain("onReviewAsk={() => controller.reviewAsk()}");
  });

  test("the banner is fixed under the header, outside the ScrollView", () => {
    const screen = between(SCREEN, "export function WorkflowStartScreen", "const styles");
    const header = screen.indexOf("<ScreenHeader");
    const banner = screen.indexOf("<AskBanner");
    const scroll = screen.indexOf("<ScrollView");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(banner).toBeGreaterThan(header);
    expect(scroll).toBeGreaterThan(banner);
    expect(screen).toContain('testID="workflow-landing-ask"');
    expect(screen).toContain("onPress={props.onReviewAsk}");
  });

  test("one offline banner, not a line per item", () => {
    expect(SCREEN.match(/testID="workflow-landing-offline"/g) ?? []).toHaveLength(1);
  });

  test("one capsule: AskCard and PillButton read `size.capsule`", () => {
    expect(CARD).toContain("minHeight: SIZE.capsule");
    expect(CARD).toContain("borderRadius: SIZE.capsule / 2");
    expect(PILL).toContain("compact ? SIZE.capsule : SIZE.bigButton");
    expect(SCREEN).toContain('size="compact"');
    // The landing's item buttons carry no icon and no colour of their own.
    const item = between(SCREEN, "function Item", "function Landing");
    expect(item).not.toContain("palette.red");
    expect(item).not.toContain("action.icon");
  });

  test("the Session screen and the landing draw the SAME banner component", () => {
    expect(SESSION).toContain("<AskBanner");
    expect(SESSION).not.toContain("<AskSlim");
    expect(BANNER).toContain("<AskSlim");
    expect(BANNER).toContain('actionLabel="Review"');
  });
});

describe("the landing's evidence comes in light AND dark", () => {
  /** The names a flow hands to `_shot`, in order. */
  const shots = (source: string) =>
    [...source.matchAll(/file: _shot\.yaml\n\s+env:\n\s+SHOT: "([^"]+)"/g)].map((m) => m[1]);

  test("`_shot` shoots light, flips to dark, shoots again and returns to light", () => {
    expect(SHOT_FLOW).toMatch(
      /takeScreenshot: \$\{SHOT\}-light[\s\S]*NAME: "dark"[\s\S]*takeScreenshot: \$\{SHOT\}-dark[\s\S]*NAME: "light"/,
    );
  });

  test("flows 46 / 46b take their six states through `_shot`", () => {
    expect(shots(LANDING_FLOW)).toEqual([
      "46-landing",
      "46-landing-ask",
      "46-landing-sheet",
      "46-landing-delete",
    ]);
    expect(shots(LANDING_SHOTS_FLOW)).toEqual(["46b-landing-two-asks", "46b-landing-offline"]);
  });

  test("neither flow shoots or flips the appearance by itself", () => {
    // A flip around `_shot` would save a dark frame under the `-light` name.
    for (const source of [LANDING_FLOW, LANDING_SHOTS_FLOW]) {
      expect(source).not.toContain("takeScreenshot");
      expect(source).not.toContain("appearance.js");
    }
  });
});
