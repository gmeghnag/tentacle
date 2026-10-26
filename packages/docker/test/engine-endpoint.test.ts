import { describe, expect, test } from "bun:test";
import { contextStoreKey, endpointLabel, resolveEngineEndpoint } from "../src/engine-endpoint.ts";

const HOME = "/home/u";
const CFG = `${HOME}/.docker`;

/** A fake docker config dir: `contexts` maps a name to its endpoint (+ optional TLS files). */
function fs(
  opts: {
    current?: string;
    configDir?: string;
    contexts?: Record<
      string,
      { host: string; skipTLSVerify?: boolean; tls?: Record<string, string> }
    >;
    files?: Record<string, string>;
  } = {},
) {
  const dir = opts.configDir ?? CFG;
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  if (opts.current !== undefined) {
    files.set(`${dir}/config.json`, JSON.stringify({ auths: {}, currentContext: opts.current }));
  }
  for (const [name, c] of Object.entries(opts.contexts ?? {})) {
    const key = contextStoreKey(name);
    files.set(
      `${dir}/contexts/meta/${key}/meta.json`,
      JSON.stringify({
        Name: name,
        Metadata: {},
        Endpoints: { docker: { Host: c.host, SkipTLSVerify: c.skipTLSVerify ?? false } },
      }),
    );
    for (const [f, text] of Object.entries(c.tls ?? {})) {
      files.set(`${dir}/contexts/tls/${key}/docker/${f}`, text);
    }
  }
  return (path: string): string | undefined => files.get(path);
}

const resolve = (
  env: Record<string, string>,
  readFile = fs(),
  extra: { context?: string; allowInsecureTcp?: boolean } = {},
) => resolveEngineEndpoint({ env: { HOME, ...env }, readFile, ...extra });

const TLS = { "ca.pem": "CA", "cert.pem": "CERT", "key.pem": "KEY" };

describe("resolveEngineEndpoint: precedence (docker CLI order)", () => {
  const files = fs({
    current: "desktop",
    contexts: {
      desktop: { host: "unix:///d.sock" },
      podman: { host: "unix:///p.sock" },
      explicit: { host: "unix:///e.sock" },
    },
  });

  test("--context > DOCKER_HOST > DOCKER_CONTEXT > currentContext > default", () => {
    const all = { DOCKER_HOST: "unix:///h.sock", DOCKER_CONTEXT: "podman" };
    expect(resolve(all, files, { context: "explicit" })).toMatchObject({
      path: "/e.sock",
      source: 'context "explicit"',
    });
    expect(resolve(all, files)).toMatchObject({ path: "/h.sock", source: "DOCKER_HOST" });
    expect(resolve({ DOCKER_CONTEXT: "podman" }, files)).toMatchObject({
      path: "/p.sock",
      source: 'context "podman" (DOCKER_CONTEXT)',
    });
    expect(resolve({}, files)).toMatchObject({ path: "/d.sock", source: 'context "desktop"' });
    expect(resolve({}, fs())).toEqual({
      kind: "unix",
      path: "/var/run/docker.sock",
      local: true,
      source: 'context "default"',
    });
  });

  test("the default context honours DOCKER_HOST", () => {
    expect(resolve({ DOCKER_HOST: "unix:///h.sock" }, files, { context: "default" })).toMatchObject(
      { path: "/h.sock" },
    );
  });

  test("the context store key is sha256(name) (verified against Docker Desktop's podman context)", () => {
    expect(contextStoreKey("podman")).toMatch(/^2f259bab/);
  });

  test("DOCKER_CONFIG moves the config dir", () => {
    const moved = fs({
      configDir: "/cfg",
      current: "podman",
      contexts: { podman: { host: "unix:///p.sock" } },
    });
    expect(resolve({ DOCKER_CONFIG: "/cfg" }, moved)).toMatchObject({ path: "/p.sock" });
  });

  test("an unknown context is actionable; a malformed config.json too", () => {
    expect(() => resolve({}, fs(), { context: "nope" })).toThrow(
      `docker context "nope" not found (looked in ${CFG}/contexts/meta) — list them with \`docker context ls\``,
    );
    expect(() => resolve({}, fs({ files: { [`${CFG}/config.json`]: "{nope" } }))).toThrow(
      `cannot parse ${CFG}/config.json`,
    );
  });
});

describe("resolveEngineEndpoint: tcp + TLS", () => {
  test("DOCKER_TLS_VERIFY + DOCKER_CERT_PATH → TLS on :2376 with the PEM contents", () => {
    const files = fs({
      files: { "/certs/ca.pem": "CA", "/certs/cert.pem": "CERT", "/certs/key.pem": "KEY" },
    });
    const ep = resolve(
      { DOCKER_HOST: "tcp://h.example", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/certs" },
      files,
    );
    expect(ep).toEqual({
      kind: "tcp",
      host: "h.example",
      port: 2376,
      tls: { ca: "CA", cert: "CERT", key: "KEY", dir: "/certs" },
      local: false,
      source: "DOCKER_HOST",
    });
    expect(endpointLabel(ep)).toBe("tcp://h.example:2376 (TLS)");
  });

  test("TLS material defaults to the config dir; none of it → names the dir", () => {
    const files = fs({ files: { [`${CFG}/ca.pem`]: "CA" } });
    expect(resolve({ DOCKER_HOST: "tcp://h:1234", DOCKER_TLS_VERIFY: "1" }, files)).toMatchObject({
      port: 1234,
      tls: { ca: "CA", dir: CFG },
    });
    expect(() =>
      resolve({ DOCKER_HOST: "tcp://h", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/empty" }),
    ).toThrow(
      "TLS is enabled (DOCKER_TLS_VERIFY) but /empty has none of ca.pem, cert.pem, key.pem",
    );
    const half = fs({ files: { "/c/cert.pem": "CERT" } });
    expect(() =>
      resolve({ DOCKER_HOST: "tcp://h", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/c" }, half),
    ).toThrow("TLS client certificate in /c is incomplete: key.pem is missing");
  });

  test("a context with TLS files → TLS from contexts/tls/<key>/docker", () => {
    const files = fs({ contexts: { remote: { host: "tcp://r:2376", tls: TLS } } });
    expect(resolve({}, files, { context: "remote" })).toMatchObject({
      kind: "tcp",
      port: 2376,
      tls: {
        ca: "CA",
        cert: "CERT",
        key: "KEY",
        dir: `${CFG}/contexts/tls/${contextStoreKey("remote")}/docker`,
      },
    });
  });

  test("plaintext tcp:// is refused, naming TLS :2376, ssh:// and --insecure-docker-tcp", () => {
    let message = "";
    try {
      resolve({ DOCKER_HOST: "tcp://h:2375" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(
      "refusing plaintext tcp://h:2375 (DOCKER_HOST): an unauthenticated Docker API is root on that server",
    );
    expect(message).toContain("tcp://h:2376 + DOCKER_TLS_VERIFY=1");
    expect(message).toContain("ssh://user@h");
    expect(message).toContain("--insecure-docker-tcp");
  });

  test("…and allowed with allowInsecureTcp (marked insecure)", () => {
    expect(resolve({ DOCKER_HOST: "tcp://h" }, fs(), { allowInsecureTcp: true })).toEqual({
      kind: "tcp",
      host: "h",
      port: 2375,
      insecure: true,
      local: false,
      source: "DOCKER_HOST",
    });
  });

  test("SkipTLSVerify is refused like plaintext, unless allowed", () => {
    const files = fs({
      contexts: { lax: { host: "tcp://l:2376", skipTLSVerify: true, tls: TLS } },
    });
    expect(() => resolve({}, files, { context: "lax" })).toThrow(
      /refusing TLS without server verification \(SkipTLSVerify\) to l:2376/,
    );
    expect(resolve({}, files, { context: "lax", allowInsecureTcp: true })).toMatchObject({
      insecure: true,
      tls: { ca: "CA" },
    });
  });

  test("an IPv6 literal loses its brackets", () => {
    expect(
      resolve({ DOCKER_HOST: "tcp://[::1]:2375" }, fs(), { allowInsecureTcp: true }),
    ).toMatchObject({ host: "::1", port: 2375 });
  });
});

describe("resolveEngineEndpoint: ssh and unsupported schemes", () => {
  test("ssh://user@host:port is parsed (not local)", () => {
    const ep = resolve({ DOCKER_HOST: "ssh://me@build.example:2222" });
    expect(ep).toEqual({
      kind: "ssh",
      host: "build.example",
      user: "me",
      port: 2222,
      local: false,
      source: "DOCKER_HOST",
    });
    expect(endpointLabel(ep)).toBe("ssh://me@build.example:2222");
    expect(resolve({ DOCKER_HOST: "ssh://box" })).toEqual({
      kind: "ssh",
      host: "box",
      local: false,
      source: "DOCKER_HOST",
    });
  });

  test("option injection and paths are refused", () => {
    expect(() => resolve({ DOCKER_HOST: "ssh://-oProxyCommand=x" })).toThrow(
      /must not start with '-'/,
    );
    expect(() => resolve({ DOCKER_HOST: "ssh://-l@h" })).toThrow(/must not start with '-'/);
    expect(() => resolve({ DOCKER_HOST: "ssh://u@h\tx" })).toThrow(/whitespace\/control/);
    expect(() => resolve({ DOCKER_HOST: "ssh://u@h/path" })).toThrow(/a path is not supported/);
  });

  test("npipe / fd / http are unsupported; a relative unix path is invalid", () => {
    expect(() => resolve({ DOCKER_HOST: "npipe:////./pipe/docker_engine" })).toThrow(
      /unsupported Docker host scheme/,
    );
    expect(() => resolve({ DOCKER_HOST: "fd://" })).toThrow(/unsupported Docker host scheme/);
    expect(() => resolve({ DOCKER_HOST: "https://h" })).toThrow(/unsupported Docker host scheme/);
    expect(() => resolve({ DOCKER_HOST: "unix://rel.sock" })).toThrow(/must be absolute/);
  });

  test("only unix is local", () => {
    expect(resolve({}).local).toBe(true);
    expect(resolve({ DOCKER_HOST: "ssh://h" }).local).toBe(false);
    expect(resolve({ DOCKER_HOST: "tcp://h" }, fs(), { allowInsecureTcp: true }).local).toBe(false);
  });
});
