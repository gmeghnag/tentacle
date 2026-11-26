/**
 * The daemon's browser host port (docs/feat/browser-inspect.md B5b): what a
 * `SessionHost` needs of the user's Chrome beyond the tools — `browser/status`
 * (the link's state + the session's own tabs) and the tab group's title. Built
 * ONLY by the laptop's own hosts (the worker, `serve`), beside the toolset;
 * never by a pod path (AGENTS §7), so its presence IS "this host has the browser".
 */
import { execFile } from "node:child_process";
import { linkState } from "@tentacle/browser";
import type { BrowserHostPort } from "@tentacle/daemon";
import type { BrowserStatusResult } from "@tentacle/protocol";
import type { BrowserToolset } from "@tentacle/tools";
import { hubSocketPath, probeSocket } from "./browser-host.ts";
import { type BrowserInstallEnv, chromeManaged, nativeHostInstalled } from "./browser-install.ts";
import type { BrowserLink } from "./browser-link.ts";

/** The facts the link state is decided from (tests inject them). */
export interface BrowserLinkProbes {
  manifestOk(): boolean;
  hubAnswers(): Promise<boolean>;
  /** Undefined: not known here (not macOS, or the probe failed). */
  chromeRunning(): Promise<boolean | undefined>;
  managed(): boolean;
}

/** `pgrep -x "Google Chrome"` (macOS): exit 0 = running, 1 = not, else unknown. */
function chromeRunningDarwin(): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", "Google Chrome"], { timeout: 2000 }, (error) => {
      if (error === null) resolve(true);
      else resolve(error.code === 1 ? false : undefined);
    });
  });
}

/** The real probes: the native-host files, the hub socket, the Chrome process, the policy file. */
export function defaultBrowserLinkProbes(
  env: Pick<BrowserInstallEnv, "configDir" | "home" | "extensionIds" | "managedPolicyPath">,
): BrowserLinkProbes {
  return {
    manifestOk: () => nativeHostInstalled(env),
    hubAnswers: () => probeSocket(hubSocketPath(env.configDir)),
    chromeRunning: chromeRunningDarwin,
    managed: () => chromeManaged(env),
  };
}

export interface BrowserHostPortDeps {
  /** The daemon's ONE link: `connected` there needs no probe. */
  readonly link: Pick<BrowserLink, "status">;
  /** The daemon's ONE toolset: it holds the leases and the per-session masking keys. */
  readonly toolset: Pick<BrowserToolset, "status" | "retitle">;
  readonly probes: BrowserLinkProbes;
}

const settle = async <T>(probe: () => T | Promise<T>, fallback: T): Promise<T> => {
  try {
    return await probe();
  } catch {
    return fallback;
  }
};

async function linkOf(
  deps: BrowserHostPortDeps,
): Promise<NonNullable<BrowserStatusResult["link"]>> {
  const managed = await settle(() => deps.probes.managed(), false);
  if (deps.link.status().state === "connected") {
    return { state: "connected", managed };
  }
  const [hubAnswers, chromeRunning, manifestOk] = await Promise.all([
    settle(() => deps.probes.hubAnswers(), false),
    settle(() => deps.probes.chromeRunning(), undefined),
    settle(() => deps.probes.manifestOk(), false),
  ]);
  return { state: linkState({ hubAnswers, manifestOk, chromeRunning }), managed };
}

/** The port a laptop host hands its `SessionHost` (`browser`). Never throws. */
export function createBrowserHostPort(deps: BrowserHostPortDeps): BrowserHostPort {
  return {
    async status(uid) {
      const [link, own] = await Promise.all([
        linkOf(deps),
        settle(() => deps.toolset.status(uid), { tabs: [] }),
      ]);
      return {
        available: true,
        link,
        ...(own.heldElsewhere === true ? { heldElsewhere: true } : {}),
        tabs: own.tabs,
      };
    },
    retitle(uid, title) {
      try {
        deps.toolset.retitle(uid, title);
      } catch {
        // best effort: the group keeps its title
      }
    },
  };
}
