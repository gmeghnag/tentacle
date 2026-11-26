/**
 * docs/feat/session-apps-container-ports.md OD2: which container may be put on
 * the internet. Stricter than the device preview, which is unchanged. Pure.
 * Mutation: ignore `scope` → every refusal here fails.
 */
import { describe, expect, test } from "bun:test";
import type { EngineEndpoint } from "../src/engine-endpoint.ts";
import { previewTargetOf } from "../src/preview-target.ts";

const UNIX: EngineEndpoint = {
  kind: "unix",
  path: "/Users/me/.docker/run/engine.sock",
  local: true,
  source: "test",
};

const run = (host: Record<string, unknown>, scope?: "link") =>
  previewTargetOf({
    inspect: {
      Id: "a".repeat(64),
      Name: "/web",
      State: { Running: true },
      HostConfig: { NetworkMode: "bridge", Privileged: false, ...host },
      NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } },
      Mounts: [],
    },
    port: 80,
    engine: "docker",
    endpoint: UNIX,
    ...(scope === undefined ? {} : { scope }),
  });

const caps = [
  "ALL",
  "SYS_ADMIN",
  "NET_ADMIN",
  "SYS_PTRACE",
  "SYS_MODULE",
  "DAC_READ_SEARCH",
  "SYS_RAWIO",
  "CAP_SYS_ADMIN",
  "sys_admin",
];

const REFUSED: [string, Record<string, unknown>][] = [
  ["PidMode host", { PidMode: "host" }],
  ["IpcMode host", { IpcMode: "host" }],
  ["UTSMode host", { UTSMode: "host" }],
  ...caps.map((cap): [string, Record<string, unknown>] => [`CapAdd ${cap}`, { CapAdd: [cap] }]),
  ["a device", { Devices: [{ PathOnHost: "/dev/kvm" }] }],
  ...["seccomp=unconfined", "seccomp:unconfined", "apparmor=unconfined", "apparmor:unconfined"].map(
    (opt): [string, Record<string, unknown>] => [opt, { SecurityOpt: [opt] }],
  ),
  ["CapAdd that is not a list", { CapAdd: "SYS_ADMIN" }],
  ["Devices that are not a list", { Devices: {} }],
  ["SecurityOpt that is not a list", { SecurityOpt: "seccomp=unconfined" }],
];

describe("link scope", () => {
  for (const [name, host] of REFUSED) {
    test(`refuses ${name}; the device scope is unchanged`, () => {
      expect(run(host, "link").ok).toBe(false);
      expect(run(host).ok).toBe(true);
    });
  }

  test("accepts an ordinary container, with empty lists and harmless settings", () => {
    const ordinary = {
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      CapAdd: null,
      Devices: [],
      SecurityOpt: ["no-new-privileges"],
    };
    expect(run(ordinary, "link").ok).toBe(true);
    expect(run({ CapAdd: ["NET_BIND_SERVICE"] }, "link").ok).toBe(true);
  });

  test("still refuses everything the device scope refuses", () => {
    expect(run({ Privileged: true }, "link").ok).toBe(false);
    expect(run({ NetworkMode: "host" }, "link").ok).toBe(false);
  });
});
