/**
 * Where the app's computers come from (docs/feat/mobile-app-shell.md). 11a ships
 * only the DEV source: a computer read from the build environment, no persisted
 * token, no "add computer" form. Task 9 deletes it for a Keychain-backed paired
 * source behind this same interface, so no screen changes then.
 *
 * Pure: no React, no React Native, no I/O — the env is injected.
 */

/** One computer the app can dial. `token` is build-time only in 11a (debt: task 9). */
export interface ComputerRecord {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly token?: string;
}

export interface ComputerSource {
  list(): Promise<readonly ComputerRecord[]>;
}

/** The build env named a URL the app cannot dial: shown on `Pair`, naming the variable. */
export class ComputerConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = "ComputerConfigError";
    this.variable = variable;
  }
}

/** Where the dev computer is configured (exported: the error messages name them). */
const URL_VAR = "EXPO_PUBLIC_TENTACLE_URL";
const TOKEN_VAR = "EXPO_PUBLIC_TENTACLE_TOKEN";
const NAME_VAR = "EXPO_PUBLIC_TENTACLE_NAME";

/** The one computer a dev build is pointed at. */
const DEV_COMPUTER_ID = "dev";

/**
 * `ws:`/`wss:` only: the client's channel factory speaks WebSocket, so an
 * `http:` URL would fail at the dial with a far worse message.
 */
function parseWsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ComputerConfigError(URL_VAR, `${URL_VAR} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ComputerConfigError(
      URL_VAR,
      `${URL_VAR} must start with ws:// or wss:// (got ${JSON.stringify(url.protocol)})`,
    );
  }
  return url;
}

/**
 * A computer from `EXPO_PUBLIC_TENTACLE_URL` / `_TOKEN` / `_NAME` (inlined at
 * build time: a shipped build bakes them in — task 9 deletes this source).
 *
 * No URL → `[]`, so the app shows the pairing placeholder rather than crashing.
 * A URL that is not `ws:`/`wss:` → `list()` rejects with
 * `ComputerConfigError`; the caller shows it on `Pair` and names the variable.
 */
export function devComputerSource(env: Record<string, string | undefined>): ComputerSource {
  return {
    async list(): Promise<readonly ComputerRecord[]> {
      const rawUrl = env[URL_VAR];
      if (rawUrl === undefined || rawUrl === "") {
        return [];
      }
      const url = parseWsUrl(rawUrl);
      const token = env[TOKEN_VAR];
      const name = env[NAME_VAR];
      return [
        {
          id: DEV_COMPUTER_ID,
          name: name === undefined || name === "" ? url.host : name,
          url: url.toString(),
          ...(token === undefined || token === "" ? {} : { token }),
        },
      ];
    },
  };
}
