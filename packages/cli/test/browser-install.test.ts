import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_HOST_NAME,
  BROWSER_HOST_SUBCOMMAND,
} from "@tentacle/browser";
import {
  browserCommand,
  installBrowser,
  manifestPath,
  statusBrowser,
  uninstallBrowser,
  wrapperPath,
  wrapperScript,
} from "../src/browser-install.ts";
import { main } from "../src/main.ts";

let root: string;
let env: Parameters<typeof installBrowser>[0];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tbi-"));
  env = {
    configDir: join(root, "cfg"),
    home: join(root, "home"),
    self: ["/opt/my bin/bun", "/src/main.ts"],
    managedPolicyPath: join(root, "no-policy.plist"),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("tentacle browser install / status / uninstall", () => {
  test("the manifest names ONLY the pinned origin and the absolute wrapper, no wildcard", () => {
    installBrowser(env);
    const m = JSON.parse(readFileSync(manifestPath(env.home), "utf8"));
    expect(m).toEqual({
      name: BROWSER_HOST_NAME,
      description: "tentacle browser host",
      path: wrapperPath(env.configDir),
      type: "stdio",
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    });
    expect(m.path.startsWith("/")).toBe(true);
    expect(JSON.stringify(m)).not.toContain("*");
  });

  test("the wrapper is executable, quotes the command, pins the config dir, forwards argv", () => {
    installBrowser(env);
    const w = wrapperPath(env.configDir);
    expect(statSync(w).mode & 0o111).not.toBe(0);
    const text = readFileSync(w, "utf8");
    expect(text).toBe(wrapperScript(env.self, env.configDir));
    expect(text).toContain("'/opt/my bin/bun' '/src/main.ts' __browser-host \"$@\"");
    expect(text).toContain(`export TENTACLE_CONFIG_DIR='${env.configDir}'`);
  });

  test("status: not installed → hint; installed → ok; stale origin → reinstall hint; managed note", async () => {
    expect((await statusBrowser(env))[0]).toContain("not installed");
    installBrowser(env);
    expect((await statusBrowser(env))[0]).toBe("native host: installed");
    // A manifest naming another extension id is stale.
    writeFileSync(
      manifestPath(env.home),
      JSON.stringify({
        path: wrapperPath(env.configDir),
        allowed_origins: ["chrome-extension://zzz/"],
      }),
    );
    expect((await statusBrowser(env))[0]).toContain("stale");
    writeFileSync(env.managedPolicyPath ?? "", "x");
    expect((await statusBrowser(env)).join("\n")).toContain("managed by an organization");
  });

  test("uninstall removes both files and is a no-op the second time", () => {
    installBrowser(env);
    expect(uninstallBrowser(env)).toHaveLength(2);
    expect(existsSync(manifestPath(env.home))).toBe(false);
    expect(existsSync(wrapperPath(env.configDir))).toBe(false);
    expect(uninstallBrowser(env)).toEqual([]);
  });

  test("the command: unknown subcommand → usage, exit 1", async () => {
    const err: string[] = [];
    expect(
      await browserCommand(["frobnicate"], env, { out: () => {}, err: (t) => err.push(t) }),
    ).toBe(1);
    expect(err.join("")).toContain("usage: tentacle browser");
  });
});

// Chrome runs the wrapper → THIS binary with the hidden word: the dispatch must
// exist for the SAME constant the wrapper writes, before any config is loaded.
describe("cli main: the hidden browser-host subcommand", () => {
  test("dispatched before config: no/wrong origin → exit 1, nothing scaffolded", async () => {
    const freshConfigDir = join(root, "fresh");
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = freshConfigDir;
    const launch = process.cwd();
    process.chdir(root);
    try {
      const err: string[] = [];
      const io = { out: () => {}, err: (t: string) => err.push(t) };
      expect(await main(["bun", "cli", BROWSER_HOST_SUBCOMMAND], io)).toBe(1);
      expect(err.join("")).toContain("unexpected caller origin");
      expect(existsSync(join(freshConfigDir, "config.jsonc"))).toBe(false);
    } finally {
      process.chdir(launch);
      const key = "TENTACLE_CONFIG_DIR";
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
