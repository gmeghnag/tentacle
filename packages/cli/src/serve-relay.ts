/**
 * `serve`'s mobile-relay settings: WHICH relay a daemon dials, and whether it
 * dials at all (docs/feat/mobile-relay.md R5a, Design §5). Pure — config, the
 * two flags and the two built-in defaults in, one decision out — so the rules are
 * unit-tested without a socket or a config file (AGENTS §7).
 *
 * The precedence is the usual one (flag › config file › built-in default):
 *
 *   `--no-relay` › `--relay <url>` › `relay.enabled` / `relay.url` › on, `DEFAULT_RELAY_URL`
 *
 * and a URL the secret may not travel over is a REFUSAL (`isRelayUrl`:
 * `wss://`, or `ws://` to a loopback host — dev and tests). The refusal is
 * returned, never silently downgraded to "off": a user who asked for a relay must
 * not lose it to a typo with no word said.
 *
 * A URL only matters when the relay will actually be used, so an opted-out
 * daemon (`--no-relay`, `relay.enabled: false`) never validates — and never
 * refuses — the URL beside it.
 */
import { DEFAULT_RELAY_URL, isRelayUrl } from "@tentacle/protocol";

/** What `serve` was told about the relay, from every source. */
export interface RelayOptions {
  /** `serve --relay <url>`: names the relay (implies enabled). */
  readonly flagUrl?: string | undefined;
  /** `serve --no-relay`: the relay is off, whatever the config says. */
  readonly noRelay?: boolean | undefined;
  /** The config file's `relay` section (absent when it omits it). */
  readonly config?: { readonly enabled?: boolean | undefined; readonly url?: string | undefined };
}

export type RelayChoice =
  /** Dial `url` (already validated) while something wants this daemon reachable. */
  | { readonly kind: "on"; readonly url: string }
  /** Never dial: no `relay.json` is read either, so no id is created. */
  | { readonly kind: "off" }
  /** The URL given cannot carry the secret: `serve` refuses to start, with this reason. */
  | { readonly kind: "refused"; readonly reason: string };

/** The reason a URL is refused, naming what is wrong rather than a rule number. */
const URL_REASON =
  "must be wss://, or ws:// to a loopback host (127.0.0.1 / ::1 / localhost) — the daemon's relay secret travels on that socket";

/**
 * Resolve the relay settings. `--no-relay` beats everything (including
 * `--relay`, which the CLI refuses as a conflict before reaching here), and a
 * `--relay` URL beats the config's.
 */
export function relayChoice(options: RelayOptions): RelayChoice {
  if (options.noRelay === true) {
    return { kind: "off" };
  }
  const configured = options.config;
  const flagUrl = options.flagUrl;
  if (flagUrl !== undefined) {
    // A flag beats `relay.enabled: false` too: asking for a relay on the command
    // line is the most explicit thing a user can do — and it REPLACES the
    // config's URL, so that one is not validated (a value nobody reads must not
    // refuse a start).
    return isRelayUrl(flagUrl)
      ? { kind: "on", url: flagUrl }
      : { kind: "refused", reason: `--relay "${flagUrl}" ${URL_REASON}` };
  }
  if (configured?.enabled === false) {
    return { kind: "off" };
  }
  const configuredUrl = configured?.url;
  if (configuredUrl === undefined) {
    return { kind: "on", url: DEFAULT_RELAY_URL };
  }
  return isRelayUrl(configuredUrl)
    ? { kind: "on", url: configuredUrl }
    : { kind: "refused", reason: `relay.url "${configuredUrl}" ${URL_REASON}` };
}
