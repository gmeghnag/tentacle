/**
 * The hub's Workflows catalogue re-read (docs/fix/workflows-ux.md fix round 1,
 * Review finding 2), pinned from the source like `hub-tools-wiring.test.ts`
 * (`SessionScreen.tsx` is unimportable from Bun). What the re-read DOES is
 * `session-screen-catalogue.test.ts`'s; this is only that the screen calls it at
 * the hub's open and on a dimmed Workflows tap (fan and VoiceOver paths).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The source with its comment lines removed: prose names things the code must not do. */
const SCREEN = readFileSync(join(ROOT, "src", "screens", "SessionScreen.tsx"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
  .join("\n");

const slice = (from: string, to: string): string => {
  const at = SCREEN.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = SCREEN.indexOf(to, at);
  expect(end).toBeGreaterThan(at);
  return SCREEN.slice(at, end);
};

describe("the hub re-reads the workflow catalogue", () => {
  test("at each fan OPEN (inside the open branch)", () => {
    const onOpen = slice("const onHubFan = (open: boolean) => {", "\n  };");
    const branch = onOpen.slice(onOpen.indexOf("if (open) {"));
    expect(branch.slice(0, branch.indexOf("\n    }"))).toContain(
      "void controller.refreshCatalogue()",
    );
  });

  test("on a dimmed Workflows commit (the notice path, VoiceOver's too)", () => {
    const commit = slice("const commitHub = (id: HubActionId) => {", "\n  };");
    expect(commit).toContain('if (id === "workflows" && plan.kind === "notice")');
    expect(commit).toContain("void controller.refreshCatalogue()");
  });

  test("on a dimmed Workflows tap in the fan", () => {
    const flash = slice("const flashHub = (id: HubActionId) => {", "\n  };");
    expect(flash).toContain('if (id === "workflows")');
    expect(flash).toContain("void controller.refreshCatalogue()");
  });
});
