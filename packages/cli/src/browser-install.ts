/**
 * `tentacle browser install|status|uninstall` (docs/feat/browser-inspect.md §1).
 * Chrome's host manifest `path` takes no arguments (F2), so install writes a
 * 2-line wrapper `<configDir>/browser/host` that runs `<tentacle>
 * __browser-host`, and the manifest at F1's per-user path naming ONLY our
 * extension origins (no wildcards): the key-pinned dev id and, once known, the
 * Chrome Web Store id (`browserExtensionIds`, docs/feat/browser-extension-store.md).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_HOST_NAME, BROWSER_HOST_SUBCOMMAND, browserExtensionIds } from "@tentacle/browser";
import { EXTENSION_ASSETS } from "./browser-extension-assets.ts";
import { browserDir, hubSocketPath, probeSocket } from "./browser-host.ts";

export interface BrowserInstallEnv {
  readonly configDir: string;
  readonly home: string;
  /** The command that runs THIS tentacle (`selfCommand()`): absolute paths. */
  readonly self: readonly string[];
  /** The extension ids the host serves (tests inject); default `browserExtensionIds()`. */
  readonly extensionIds?: readonly string[];
  /**
   * The unpacked extension's files (tests inject); default: the table EMBEDDED
   * in this build (`EXTENSION_ASSETS`), so install works from the compiled
   * binary too (B5).
   */
  readonly extensionAssets?: Readonly<Record<string, string | Uint8Array>>;
  /** The org-managed-Chrome policy file (tests inject). */
  readonly managedPolicyPath?: string;
}

const MANAGED_POLICY = "/Library/Managed Preferences/com.google.Chrome.plist";

export function manifestPath(home: string): string {
  return join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${BROWSER_HOST_NAME}.json`,
  );
}
export function extensionDir(configDir: string): string {
  return join(browserDir(configDir), "extension");
}

export function wrapperPath(configDir: string): string {
  return join(browserDir(configDir), "host");
}

/** Single-quote for sh. */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Chrome starts the host with no tentacle env: the wrapper pins the config dir. */
export function wrapperScript(self: readonly string[], configDir: string): string {
  return `#!/bin/sh\nexport TENTACLE_CONFIG_DIR=${q(configDir)}\nexec ${self.map(q).join(" ")} ${BROWSER_HOST_SUBCOMMAND} "$@"\n`;
}

/** `chrome-extension://<id>/` per id, in order: the host manifest's `allowed_origins`. */
export function extensionOrigins(ids: readonly string[]): string[] {
  return ids.map((id) => `chrome-extension://${id}/`);
}

export function manifestJson(wrapper: string, extensionIds: readonly string[]): string {
  return `${JSON.stringify(
    {
      name: BROWSER_HOST_NAME,
      description: "tentacle browser host",
      path: wrapper,
      type: "stdio",
      allowed_origins: extensionOrigins(extensionIds),
    },
    null,
    2,
  )}\n`;
}

export function installBrowser(env: BrowserInstallEnv): string[] {
  const ids = env.extensionIds ?? browserExtensionIds();
  const wrapper = wrapperPath(env.configDir);
  mkdirSync(browserDir(env.configDir), { recursive: true, mode: 0o700 });
  writeFileSync(wrapper, wrapperScript(env.self, env.configDir));
  chmodSync(wrapper, 0o755);
  const manifest = manifestPath(env.home);
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, manifestJson(wrapper, ids));
  const out = [`host wrapper: ${wrapper}`, `host manifest: ${manifest}`];
  const assets = env.extensionAssets ?? EXTENSION_ASSETS;
  const dest = extensionDir(env.configDir);
  rmSync(dest, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(assets)) {
    const file = join(dest, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  out.push(
    `extension: ${dest}`,
    "next: chrome://extensions → Developer mode → Load unpacked → choose that folder",
    // The id is pinned by the manifest's key: a copy loaded from another
    // folder is the SAME extension, and keeps working with this host.
    "(already loaded from another folder? it keeps working: same key, same id)",
  );
  const store = ids[1];
  if (store !== undefined) {
    // Two copies (unpacked + store) are two extensions: both dial the host and
    // only one holds the hub, so the other's popup says «not linked».
    out.push(
      `or install it from the Chrome Web Store: https://chromewebstore.google.com/detail/${store}`,
      "(keep only one of the two copies enabled)",
    );
  }
  return out;
}

export function uninstallBrowser(env: BrowserInstallEnv): string[] {
  const removed: string[] = [];
  for (const p of [
    manifestPath(env.home),
    wrapperPath(env.configDir),
    extensionDir(env.configDir),
  ]) {
    if (existsSync(p)) {
      rmSync(p, { force: true, recursive: true });
      removed.push(p);
    }
  }
  return removed;
}

/**
 * The native host is installed and current: the manifest names THIS wrapper and
 * exactly our extension origins (a manifest written before the store id was
 * known is stale: reinstall adds it), and the wrapper exists. Pure over the files; the
 * `status` command and `browser/status` (B5b) share it.
 */
export function nativeHostInstalled(
  env: Pick<BrowserInstallEnv, "configDir" | "home" | "extensionIds">,
): boolean {
  const want = extensionOrigins(env.extensionIds ?? browserExtensionIds());
  const wrapper = wrapperPath(env.configDir);
  const manifest = manifestPath(env.home);
  if (!existsSync(manifest)) return false;
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8")) as {
      path?: string;
      allowed_origins?: string[];
    };
    return (
      m.path === wrapper &&
      Array.isArray(m.allowed_origins) &&
      m.allowed_origins.length === want.length &&
      want.every((o, i) => m.allowed_origins?.[i] === o) &&
      existsSync(wrapper)
    );
  } catch {
    return false;
  }
}

/** Chrome is managed by an organization (a policy may block the extension or the debugger). */
export function chromeManaged(env: Pick<BrowserInstallEnv, "managedPolicyPath">): boolean {
  return existsSync(env.managedPolicyPath ?? MANAGED_POLICY);
}

export async function statusBrowser(env: BrowserInstallEnv): Promise<string[]> {
  const lines: string[] = [];
  lines.push(
    nativeHostInstalled(env)
      ? "native host: installed"
      : "native host: not installed (or stale) — run `tentacle browser install`",
  );
  lines.push(
    (await probeSocket(hubSocketPath(env.configDir)))
      ? "chrome link: connected (extension running)"
      : "chrome link: not running (Chrome closed, or the tentacle extension is not enabled)",
  );
  if (chromeManaged(env)) {
    lines.push(
      "note: this Chrome is managed by an organization — a policy may block developer-mode extensions or the debugger API",
    );
  }
  return lines;
}

export async function browserCommand(
  positional: readonly string[],
  env: BrowserInstallEnv,
  io: { readonly out: (t: string) => void; readonly err: (t: string) => void },
): Promise<number> {
  const sub = positional[0];
  if (sub === "install") {
    for (const l of installBrowser(env)) io.out(`${l}\n`);
    return 0;
  }
  if (sub === "uninstall") {
    const removed = uninstallBrowser(env);
    io.out(
      removed.length > 0
        ? `${removed.map((p) => `removed ${p}`).join("\n")}\n`
        : "nothing to remove\n",
    );
    return 0;
  }
  if (sub === "status") {
    for (const l of await statusBrowser(env)) io.out(`${l}\n`);
    return 0;
  }
  io.err("usage: tentacle browser install | status | uninstall\n");
  return 1;
}
