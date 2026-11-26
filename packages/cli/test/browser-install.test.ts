import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_HOST_NAME,
  BROWSER_HOST_SUBCOMMAND,
  browserExtensionIds,
} from "@tentacle/browser";
import { EXTENSION_ASSETS } from "../src/browser-extension-assets.ts";
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

describe("browser install copies the extension", () => {
  test("unpacked extension lands in <configDir>/browser/extension; uninstall removes it", () => {
    const lines = installBrowser(env);
    const dest = join(env.configDir, "browser", "extension");
    expect(existsSync(join(dest, "manifest.json"))).toBe(true);
    expect(existsSync(join(dest, "src", "background.js"))).toBe(true);
    expect(existsSync(join(dest, "package.json"))).toBe(false);
    expect(lines.join("\n")).toContain("Load unpacked");
    uninstallBrowser(env);
    expect(existsSync(dest)).toBe(false);
  });

  test("B5: the EMBEDDED table holds every extension file, byte-equal — install needs no checkout", () => {
    const app = join(import.meta.dir, "..", "..", "..", "apps", "browser-extension");
    const onDisk = [
      "manifest.json",
      ...["src", "icons"].flatMap((dir) => readdirSync(join(app, dir)).map((f) => `${dir}/${f}`)),
    ].sort();
    expect(Object.keys(EXTENSION_ASSETS).sort()).toEqual(onDisk);
    for (const rel of onDisk) {
      const asset = EXTENSION_ASSETS[rel] ?? "";
      // As base64, so a mismatch is compared byte for byte (PNGs are binary).
      expect(Buffer.from(asset).toString("base64")).toBe(
        readFileSync(join(app, rel)).toString("base64"),
      );
    }
    // Install writes the table, whatever is (not) next to this build.
    installBrowser({ ...env, extensionAssets: { "manifest.json": "{}", "src/a.js": "x" } });
    const dest = join(env.configDir, "browser", "extension");
    expect(readFileSync(join(dest, "src", "a.js"), "utf8")).toBe("x");
    expect(existsSync(wrapperPath(env.configDir))).toBe(true);
  });
});

// Chrome refuses to load an extension whose manifest names a file that is not there.
describe("browser install writes the icons", () => {
  const app = join(import.meta.dir, "..", "..", "..", "apps", "browser-extension");

  test("every icon the INSTALLED manifest names is written, byte-exact PNG", () => {
    installBrowser(env);
    const dest = join(env.configDir, "browser", "extension");
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")) as {
      icons?: Record<string, string>;
      action?: { default_icon?: Record<string, string> };
    };
    const named = [
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
    ];
    expect(Object.keys(manifest.icons ?? {})).toEqual(["16", "32", "48", "128"]);
    for (const rel of named) {
      const file = join(dest, rel);
      expect(existsSync(file)).toBe(true);
      if (existsSync(file)) {
        const bytes = readFileSync(file);
        expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(bytes.toString("base64")).toBe(readFileSync(join(app, rel)).toString("base64"));
      }
    }
  });
});

describe("tentacle browser install / status / uninstall", () => {
  test("the manifest names ONLY the pinned origin and the absolute wrapper, no wildcard", () => {
    installBrowser(env);
    const m = JSON.parse(readFileSync(manifestPath(env.home), "utf8"));
    expect(m).toEqual({
      name: BROWSER_HOST_NAME,
      description: "tentacle browser host",
      path: wrapperPath(env.configDir),
      type: "stdio",
      allowed_origins: browserExtensionIds().map((id) => `chrome-extension://${id}/`),
    });
    expect(m.allowed_origins[0]).toBe(`chrome-extension://${BROWSER_EXTENSION_ID}/`);
    expect(m.path.startsWith("/")).toBe(true);
    expect(JSON.stringify(m)).not.toContain("*");
  });

  test("store id known → the manifest allows BOTH the dev and the store copy, nothing else", () => {
    const STORE = "abcdefghijklmnopabcdefghijklmnop";
    const both = { ...env, extensionIds: browserExtensionIds(STORE) };
    installBrowser(both);
    const m = JSON.parse(readFileSync(manifestPath(env.home), "utf8"));
    expect(m.allowed_origins).toEqual([
      `chrome-extension://${BROWSER_EXTENSION_ID}/`,
      `chrome-extension://${STORE}/`,
    ]);
    expect(JSON.stringify(m)).not.toContain("*");
  });

  test("install points at the store copy only once its id is known; keep ONE copy", () => {
    const STORE = "abcdefghijklmnopabcdefghijklmnop";
    const before = installBrowser({ ...env, extensionIds: [BROWSER_EXTENSION_ID] }).join("\n");
    expect(before).not.toContain("chromewebstore");
    const after = installBrowser({ ...env, extensionIds: browserExtensionIds(STORE) }).join("\n");
    expect(after).toContain(`https://chromewebstore.google.com/detail/${STORE}`);
    expect(after).toContain("only one");
  });

  test("status: a manifest written before the store id was known is stale (reinstall adds it)", async () => {
    const STORE = "abcdefghijklmnopabcdefghijklmnop";
    installBrowser({ ...env, extensionIds: [BROWSER_EXTENSION_ID] });
    const both = { ...env, extensionIds: browserExtensionIds(STORE) };
    expect((await statusBrowser(both))[0]).toContain("stale");
    installBrowser(both);
    expect((await statusBrowser(both))[0]).toBe("native host: installed");
    // An extra origin we did not write is stale too (only ours, exactly).
    const m = JSON.parse(readFileSync(manifestPath(env.home), "utf8"));
    m.allowed_origins.push("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/");
    writeFileSync(manifestPath(env.home), JSON.stringify(m));
    expect((await statusBrowser(both))[0]).toContain("stale");
    // Same count, wrong second origin: stale too.
    m.allowed_origins = [
      m.allowed_origins[0],
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    ];
    writeFileSync(manifestPath(env.home), JSON.stringify(m));
    expect((await statusBrowser(both))[0]).toContain("stale");
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
    expect(uninstallBrowser(env)).toHaveLength(3);
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
