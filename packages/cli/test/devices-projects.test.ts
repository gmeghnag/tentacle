/**
 * `tentacle devices` / `revoke` per project (docs/feat/mobile-projects.md §5,
 * Owner Q7): the list is grouped by project (a legacy entry under the project
 * that adopted it, or in the "not yet used" group), a running serve with no
 * device gets one line, and `revoke` acts on ONE project's entry unless told
 * `--all-projects`. Each test names its mutation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "@tentacle/agent";
import {
  addDevice,
  adoptLegacy,
  deviceIdOf,
  loadOrCreateIdentity,
  readAdoption,
  readRegistry,
  writeDaemonRecord,
} from "@tentacle/daemon";
import {
  type DevicesDeps,
  devicesCommand,
  resetCommand,
  revokeCommand,
} from "../src/devices-cmd.ts";

const P = { key: projectKey("/u/tentacle"), cwd: "/u/tentacle" };
const Q = { key: projectKey("/u/assistant"), cwd: "/u/assistant" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "devices-projects-"));
  dirs.push(dir);
  loadOrCreateIdentity(dir, { name: "gabriel-mac" });
  return dir;
}

function add(dir: string, fill: number, name: string, project?: typeof P): string {
  const added = addDevice(dir, { publicKey: key(fill), name, ...(project ? { project } : {}) });
  if (!added.ok) throw new Error(added.reason);
  return added.device.id;
}

function run(dir: string, op: (deps: DevicesDeps) => number, over: Partial<DevicesDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = op({
    configDir: dir,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => 1_700_000_000_000,
    cwd: "/nowhere",
    ...over,
  });
  return { code, out: out.join(""), err: err.join("") };
}

const names = (dir: string) => {
  const r = readRegistry(dir);
  return r.ok ? r.registry.devices.map((d) => `${d.name}@${d.project?.cwd ?? "legacy"}`) : [];
};

describe("`tentacle devices` groups by project", () => {
  test("one group per project, a legacy entry under its adopter or 'Not yet used', and idle serves", () => {
    const dir = store();
    add(dir, 2, "iPhone", P);
    add(dir, 3, "iPhone", Q);
    const adopted = add(dir, 4, "Old iPad");
    add(dir, 5, "Old Pixel");
    adoptLegacy(dir, adopted, P);
    writeDaemonRecord(dir, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 4002,
      tls: false,
      cwd: "/u/idle",
      startedAt: 1,
    });
    const r = run(dir, devicesCommand);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    // Headers in first-appearance order; each device under its own header.
    expect(at("tentacle · /u/tentacle")).toBeLessThan(at("assistant · /u/assistant"));
    expect(at("Old iPad")).toBeGreaterThan(at("tentacle · /u/tentacle"));
    expect(at("Old iPad")).toBeLessThan(at("assistant · /u/assistant"));
    expect(at("Not yet used")).toBeGreaterThan(at("assistant · /u/assistant"));
    expect(at("Old Pixel")).toBeGreaterThan(at("Not yet used"));
    expect(r.out).toContain("/u/idle — running with no paired device (relay not dialled)");
  });
});

describe("`revoke` acts on ONE project (Owner Q7)", () => {
  test("the current folder's project is the default scope (mutation: computer-wide first match)", () => {
    const dir = store();
    add(dir, 2, "iPhone", P);
    add(dir, 3, "iPhone", Q);
    const r = run(dir, (deps) => revokeCommand("iPhone", deps), { cwd: "/u/assistant" });
    expect(r.code).toBe(0);
    expect(names(dir)).toEqual(["iPhone@/u/tentacle"]);
  });

  test("`--project <dir>` names the scope", () => {
    const dir = store();
    add(dir, 2, "iPhone", P);
    add(dir, 3, "iPhone", Q);
    const r = run(dir, (deps) => revokeCommand("iPhone", deps), { projectDir: "/u/tentacle" });
    expect(r.code).toBe(0);
    expect(names(dir)).toEqual(["iPhone@/u/assistant"]);
  });

  test("ambiguous outside any matching folder: refused with `project · name · id8`, nothing removed", () => {
    const dir = store();
    const a = add(dir, 2, "iPhone", P);
    const b = add(dir, 3, "iPhone", Q);
    const r = run(dir, (deps) => revokeCommand("iPhone", deps));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`tentacle · iPhone · ${a.slice(0, 8)}`);
    expect(r.err).toContain(`assistant · iPhone · ${b.slice(0, 8)}`);
    expect(names(dir)).toHaveLength(2);
  });

  test("a unique computer-wide match is revoked from anywhere", () => {
    const dir = store();
    add(dir, 2, "iPhone", P);
    add(dir, 3, "iPad", Q);
    expect(run(dir, (deps) => revokeCommand("iPad", deps)).code).toBe(0);
    expect(names(dir)).toEqual(["iPhone@/u/tentacle"]);
  });

  test("`--all-projects` revokes the phone everywhere", () => {
    const dir = store();
    add(dir, 2, "iPhone", P);
    add(dir, 3, "iPhone", Q);
    add(dir, 4, "iPad", Q);
    const r = run(dir, (deps) => revokeCommand("iPhone", deps), { allProjects: true });
    expect(r.code).toBe(0);
    expect(names(dir)).toEqual(["iPad@/u/assistant"]);
  });

  test("an adopted legacy entry counts as its adopter's, and its adoption goes with it", () => {
    const dir = store();
    const legacy = add(dir, 4, "Old iPad");
    adoptLegacy(dir, legacy, P);
    const r = run(dir, (deps) => revokeCommand("Old iPad", deps), { cwd: "/u/tentacle" });
    expect(r.code).toBe(0);
    expect(readAdoption(dir, deviceIdOf(key(4))).kind).toBe("none");
  });
});

describe("`devices reset` stays computer-wide (Owner Q13, F15)", () => {
  test("adoption records are cleared with the registry (mutation: drop clearAdoptions)", async () => {
    const dir = store();
    const legacy = add(dir, 4, "Old iPad");
    adoptLegacy(dir, legacy, P);
    // An ORPHAN adoption (its entry revoked by hand): only a directory-wide clear takes it.
    adoptLegacy(dir, "9".repeat(16), Q);
    const code = await resetCommand({
      configDir: dir,
      out: () => {},
      err: () => {},
      now: () => 1_700_000_000_000,
      hostname: "gabriel-mac",
      yes: true,
    });
    expect(code).toBe(0);
    expect(readAdoption(dir, legacy).kind).toBe("none");
    expect(readAdoption(dir, "9".repeat(16)).kind).toBe("none");
    expect(names(dir)).toEqual([]);
  });
});
