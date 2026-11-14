/**
 * docs/feat/session-hop.md slice H6, first commit — the pure move of
 * `detachedRunOf` out of `main()`'s closure (H2's design review, M8).
 *
 * Two questions are pinned here, and they are the same two `attach` has always
 * asked: is this workload a detached run's (a record, or a live lock, in its run
 * dir), and is it THIS place's (`at`) or another place's (`elsewhere`, S2's
 * refusal)? A hop's D7(a) reuses the answer, so a regression here would let a
 * session join — or refuse to join — a run that is not the one it means.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DetachedRunDeps, detachedRunOf } from "../src/detached-run-of.ts";
import { keptDir, locationKey, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { type ProcOf, acquireResidentLock } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  RUN_STATE_VERSION,
  ensureRunDir,
  runDirFor,
  writeOwner,
} from "../src/run-state.ts";

const LAPTOP = "100";

/** A `/proc` that says every pid is alive, started at `LAPTOP`. */
const alive: ProcOf = () => ({ state: "S", start: LAPTOP });

const entry = (name: string, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name,
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
  ...over,
});

const ownerRecord = (sessionId: string): OwnerRecord => ({
  schemaVersion: RUN_STATE_VERSION,
  kind: "relay",
  pid: 42,
  appVersion: "1.2.3",
  sessionId,
  state: "idle",
  lastActivityAt: 7,
  autoAccept: false,
  rm: false,
  cwd: "/work",
});

function rig(entries: readonly KeptEntry[]) {
  const configDir = mkdtempSync(join(tmpdir(), "detached-run-of-"));
  for (const e of entries) {
    recordKept(keptDir(configDir), e);
  }
  const deps: DetachedRunDeps = { configDir, dir: keptDir(configDir), procOf: alive };
  return {
    configDir,
    deps,
    index: () => readKept(keptDir(configDir)),
    /** `e`'s run dir, with an owner record (a live run's evidence). */
    withOwner: (e: KeptEntry, sessionId = "s-1") => {
      const dir = ensureRunDir(runDirFor(configDir, e));
      writeOwner(dir, ownerRecord(sessionId));
      return dir;
    },
    /** `e`'s run dir, with a LIVE lock (a draining relay's). */
    withLock: (e: KeptEntry) => {
      const dir = ensureRunDir(runDirFor(configDir, e));
      const lock = acquireResidentLock(dir, alive);
      return { dir, lock };
    },
    done: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

describe("H6/M8 `detachedRunOf` — a workload is a detached run's when its run dir has a record or a live lock", () => {
  test("a kept entry with NO run dir evidence is not a detached run", () => {
    // A `run` that finished and left its workload kept: no owner, no lock.
    // Mutation: treat any kept entry as a run → `attach` (and a hop's D7a)
    // would refuse the user's own workload as "in use by another session".
    const r = rig([entry("box")]);
    try {
      expect(detachedRunOf(r.deps, "box", "docker")).toBeNull();
    } finally {
      r.done();
    }
  });

  test("an owner record makes it one, and the answer carries the run's own facts", () => {
    const r = rig([entry("box")]);
    try {
      const dir = r.withOwner(entry("box"));
      const found = detachedRunOf(r.deps, "box", "docker");
      expect(found).not.toBeNull();
      if (found === null) return;
      expect(found.elsewhere).toBe(false);
      expect(found.dir).toBe(dir);
      expect(found.entry.name).toBe("box");
      expect(found.holder).toBeNull();
      expect(found.owner.kind).toBe("owner");
    } finally {
      r.done();
    }
  });

  test("a LIVE lock makes it one, holder and all (a relay is running it)", () => {
    const r = rig([entry("box")]);
    try {
      const { lock } = r.withLock(entry("box"));
      const found = detachedRunOf(r.deps, "box", "docker");
      if (found === null) throw new Error("expected the locked run");
      // Mutation: drop the `holder !== null` arm → a live relay's run is missed
      // and a second owner is allowed to start on it.
      expect(found.holder?.pid).toBe(process.pid);
      lock.release();
    } finally {
      r.done();
    }
  });

  test("another engine's entry of the same name is not this one", () => {
    const r = rig([entry("box", { engine: "kubernetes", server: "https://k:1", namespace: "n" })]);
    try {
      r.withOwner(entry("box", { engine: "kubernetes", server: "https://k:1", namespace: "n" }));
      expect(detachedRunOf(r.deps, "box", "docker")).toBeNull();
      expect(detachedRunOf(r.deps, "box", "kubernetes")).not.toBeNull();
    } finally {
      r.done();
    }
  });

  test("`at` naming this place: this attach's run; naming another: `elsewhere` (S2)", () => {
    // Two workloads both called `box` at two endpoints (one run each).
    const local = entry("box");
    const remote = entry("box", { endpoint: "ssh://u@h:22" });
    const r = rig([local, remote]);
    try {
      r.withOwner(local);
      r.withOwner(remote);
      // `at` = the remote place: that entry is THIS attach's, never `elsewhere`.
      const mine = detachedRunOf(r.deps, "box", "docker", () => atOf(remote));
      if (mine === null) throw new Error("expected the named run");
      expect(mine.elsewhere).toBe(false);
      expect(mine.entry.endpoint).toBe("ssh://u@h:22");
      // `at` names the local place: the remote run is still there, so the search
      // ends up with the one it could NOT rule out, and says so.
      const other = detachedRunOf(r.deps, "box", "docker", () => atOf(local));
      if (other === null) throw new Error("expected the other place's run");
      expect(other.elsewhere).toBe(false);
      expect(other.entry.endpoint).toBe("unix:///var/run/docker.sock");
    } finally {
      r.done();
    }
  });

  test("`at` names a place NO run is at: `elsewhere` on the live one it could not rule out", () => {
    const r = rig([entry("box")]);
    try {
      r.withOwner(entry("box"));
      // Note `held`: only a LIVE relay comes back as `elsewhere`; a record alone
      // at another place is not a second owner to refuse for, so the search goes
      // on. Mutation: return the record-only run as `elsewhere` → an `attach`
      // from another folder refuses a run that ended.
      const { lock } = r.withLock(entry("box"));
      const found = detachedRunOf(r.deps, "box", "docker", () => "somewhere-else");
      if (found === null) throw new Error("expected the elsewhere run");
      expect(found.elsewhere).toBe(true);
      expect(found.holder?.pid).toBe(process.pid);
      lock.release();
    } finally {
      r.done();
    }
  });

  test("a record-only run at another place is not `elsewhere` (nothing here holds it)", () => {
    const r = rig([entry("box")]);
    try {
      r.withOwner(entry("box"));
      // No lock: the run is not live, so another place's `at` is not a conflict.
      expect(detachedRunOf(r.deps, "box", "docker", () => "somewhere-else")).toBeNull();
    } finally {
      r.done();
    }
  });

  test("no engine named: the first matching entry decides (the plain `attach` call)", () => {
    const r = rig([entry("box", { engine: "podman", endpoint: "unix:///run/podman.sock" })]);
    try {
      r.withOwner(entry("box", { engine: "podman", endpoint: "unix:///run/podman.sock" }));
      const found = detachedRunOf(r.deps, "box", undefined);
      if (found === null) throw new Error("expected the podman run");
      expect(found.entry.engine).toBe("podman");
    } finally {
      r.done();
    }
  });
});

/** An entry's own place, as `attach`'s `askedAt` spells it. */
const atOf = (entry: KeptEntry): string => locationKey(entry);
