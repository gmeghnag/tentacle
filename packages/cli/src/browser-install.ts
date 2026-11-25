/**
 * `tentacle browser install|status|uninstall` (docs/feat/browser-inspect.md §1).
 * Chrome's host manifest `path` takes no arguments (F2), so install writes a
 * 2-line wrapper `<configDir>/browser/host` that runs `<tentacle>
 * __browser-host`, and the manifest at F1's per-user path naming ONLY the
 * pinned extension origin (no wildcards). The unpacked extension itself ships
 * with B3; this slice is the host side.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_HOST_NAME,
  BROWSER_HOST_SUBCOMMAND,
} from "@tentacle/browser";
import { browserDir, hubSocketPath, probeSocket } from "./browser-host.ts";

export interface BrowserInstallEnv {
  readonly configDir: string;
  readonly home: string;
  /** The command that runs THIS tentacle (`selfCommand()`): absolute paths. */
  readonly self: readonly string[];
  readonly extensionId?: string;
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

export function manifestJson(wrapper: string, extensionId: string): string {
  return `${JSON.stringify(
    {
      name: BROWSER_HOST_NAME,
      description: "tentacle browser host",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`;
}

export function installBrowser(env: BrowserInstallEnv): string[] {
  const id = env.extensionId ?? BROWSER_EXTENSION_ID;
  const wrapper = wrapperPath(env.configDir);
  mkdirSync(browserDir(env.configDir), { recursive: true, mode: 0o700 });
  writeFileSync(wrapper, wrapperScript(env.self, env.configDir));
  chmodSync(wrapper, 0o755);
  const manifest = manifestPath(env.home);
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, manifestJson(wrapper, id));
  return [`host wrapper: ${wrapper}`, `host manifest: ${manifest}`];
}

export function uninstallBrowser(env: BrowserInstallEnv): string[] {
  const removed: string[] = [];
  for (const p of [manifestPath(env.home), wrapperPath(env.configDir)]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
  return removed;
}

export async function statusBrowser(env: BrowserInstallEnv): Promise<string[]> {
  const id = env.extensionId ?? BROWSER_EXTENSION_ID;
  const lines: string[] = [];
  const wrapper = wrapperPath(env.configDir);
  const manifest = manifestPath(env.home);
  let manifestOk = false;
  if (existsSync(manifest)) {
    try {
      const m = JSON.parse(readFileSync(manifest, "utf8")) as {
        path?: string;
        allowed_origins?: string[];
      };
      manifestOk = m.path === wrapper && m.allowed_origins?.[0] === `chrome-extension://${id}/`;
    } catch {
      manifestOk = false;
    }
  }
  lines.push(
    manifestOk && existsSync(wrapper)
      ? "native host: installed"
      : "native host: not installed (or stale) — run `tentacle browser install`",
  );
  lines.push(
    (await probeSocket(hubSocketPath(env.configDir)))
      ? "chrome link: connected (extension running)"
      : "chrome link: not running (Chrome closed, or the tentacle extension is not enabled)",
  );
  if (existsSync(env.managedPolicyPath ?? MANAGED_POLICY)) {
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
