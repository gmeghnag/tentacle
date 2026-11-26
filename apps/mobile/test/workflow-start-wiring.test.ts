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
    expect(SCREEN).not.toContain("numberOfLines");
    expect(SCREEN).not.toContain("ellipsizeMode");
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

  test("the sheet is only WATCHED here, and a re-render never rebuilds the controller", () => {
    expect(route).toContain("SESSION_SCREENS.get(sessionKey(computerId, sessionId))");
    expect(route).toContain("askSourceFromSheet({");
    expect(route).toContain("controller?.setOffline(offline)");
    expect(route).toContain("}, [computerId, sessionId]);");
    expect(route).toContain('playHaptic("light")');
    expect(route).not.toContain("workflowApprove");
    expect(route).not.toContain("workflowDelete");
  });
});
