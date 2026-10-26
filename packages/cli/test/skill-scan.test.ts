import { describe, expect, test } from "bun:test";
import { type SkillDiscovery, createSkillScan } from "../src/wiring.ts";

// `createSkillScan`: `latest` is the scan that STARTED last among those that
// landed — an older scan landing late must not overwrite it.

const config = {
  cwd: "/x",
  configDir: "/x/cfg",
  skillsEnabled: true,
  packages: [],
  skills: [],
  skillDiagnostics: [],
};

const found = (tag: string): SkillDiscovery => ({ skills: [], diagnostics: [tag] });

describe("createSkillScan ordering", () => {
  test("an older scan landing after a newer one does not overwrite `latest`", async () => {
    const gates: ((d: SkillDiscovery) => void)[] = [];
    const scan = createSkillScan(
      config,
      () => new Promise<SkillDiscovery>((resolve) => gates.push(resolve)),
    );
    const first = scan.scan(); // started first
    const second = scan.scan(); // started last
    gates[1]?.(found("second"));
    await second;
    expect(scan.latest().diagnostics).toEqual(["second"]);
    gates[0]?.(found("first")); // the older one lands late
    await first;
    expect(scan.latest().diagnostics).toEqual(["second"]);
  });

  test("in order, each landing becomes `latest`", async () => {
    let n = 0;
    const scan = createSkillScan(config, async () => found(`scan${++n}`));
    await scan.scan();
    await scan.scan();
    expect(scan.latest().diagnostics).toEqual(["scan2"]);
  });
});
