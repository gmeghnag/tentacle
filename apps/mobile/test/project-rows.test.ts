/**
 * The Computers screen's view-model, variant A (docs/feat/mobile-projects.md §6,
 * Tests "app"). Each test names the mutation that must turn it red (§9).
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import type { SessionListEntry } from "@tentacle/protocol";
import type { ComputerProbe } from "../src/computer-rows.ts";
import {
  JUST_PAIRED_MS,
  PROJECT_WORDS,
  type ProjectObservation,
  type ProjectRecordLike,
  type ProjectRow,
  REPROBE_MS,
  TAP_WAIT_MS,
  justPaired,
  projectSections,
  projectTap,
  reprobeDelay,
  tapSettled,
  wasBackgrounded,
} from "../src/project-rows.ts";

const entry = (over: Partial<SessionListEntry> = {}): SessionListEntry => ({
  sessionId: "s1",
  title: "t",
  cwd: "/u/tentacle",
  createdAt: 1,
  updatedAt: 2,
  running: false,
  attached: 0,
  archived: false,
  ...over,
});
const answered = (
  entries: readonly SessionListEntry[] = [entry()],
  more = false,
): ProjectObservation => ({
  probe: { ok: true, entries, ...(more ? { more: true } : {}) },
  diagnosis: "ok",
  absent: false,
});
const failed = (over: Partial<ProjectObservation> = {}): ProjectObservation => ({
  probe: { ok: false, error: new ChannelError("unreachable", "x") } as ComputerProbe,
  diagnosis: "unreachable",
  absent: false,
  ...over,
});
const rec = (
  id: string,
  computerId: string,
  label: string,
  name = "MacBook",
): ProjectRecordLike => ({
  id,
  name,
  computerId,
  project: { label, cwd: `/u/${label}` },
});

describe("projectSections", () => {
  test("groups by computer; sections and rows keep the Keychain order when states change (mutation: sort rows by state → red)", () => {
    const records = [
      rec("mac.1", "mac", "tentacle"),
      rec("mini.1", "mini", "homelab", "Mac mini"),
      rec("mac.2", "mac", "assistant"),
      rec("mac.3", "mac", "website"),
    ];
    const before = projectSections(records, [answered(), answered(), answered([]), failed()]);
    const after = projectSections(records, [failed(), answered(), answered(), answered([])]);
    for (const sections of [before, after]) {
      expect(sections.map((s) => s.computerId)).toEqual(["mac", "mini"]);
      expect(sections[0]?.rows.map((r) => r.label)).toEqual(["tentacle", "assistant", "website"]);
    }
    expect(before[1]?.name).toBe("Mac mini");
  });

  test("a written word for every state (colour-blind rule)", () => {
    const records: ProjectRecordLike[] = [
      rec("a", "mac", "working"),
      rec("b", "mac", "idle"),
      rec("c", "mac", "new"),
      rec("d", "mac", "stopped"),
      rec("e", "mac", "revoked"),
      rec("f", "mac", "reset"),
      { ...rec("g", "mac", "broken"), broken: true },
      rec("h", "other", "unreachable"),
    ];
    const rows = projectSections(records, [
      answered([entry({ running: true })]),
      answered(),
      answered([]),
      failed(),
      failed({ diagnosis: "revoked" }),
      failed({ diagnosis: "maybe-reset" }),
      answered(),
      failed(),
    ]).flatMap((s) => s.rows);
    expect(rows.map((r) => r.state)).toEqual([
      "working",
      "idle",
      "new",
      "stopped",
      "revoked",
      "maybe-reset",
      "broken",
      "unreachable",
    ]);
    expect(rows.map((r) => r.word)).toEqual(rows.map((r) => PROJECT_WORDS[r.state]));
    for (const row of rows) {
      expect(row.word.length).toBeGreaterThan(0);
    }
    expect(rows[4]?.tone).toBe("attention");
    expect(rows[3]?.tone).toBe("off");
    expect(rows[0]?.ok && !rows[3]?.ok).toBe(true);
  });

  test("stopped vs unreachable: a sibling answered → stopped; the relay's 4404 → stopped; neither → not reachable (mutation: ignore siblings → red)", () => {
    const pair = [rec("p", "mac", "tentacle"), rec("q", "mac", "website")];
    expect(projectSections(pair, [answered(), failed()])[0]?.rows[1]?.state).toBe("stopped");
    expect(projectSections(pair, [failed(), failed({ absent: true })])[0]?.rows[1]?.state).toBe(
      "stopped",
    );
    const off = projectSections(pair, [failed(), failed()])[0];
    expect(off?.rows.map((r) => r.state)).toEqual(["unreachable", "unreachable"]);
    expect(off?.state).toBe("offline");
    expect(off?.note).toContain("None of its projects answers");
    expect(projectSections(pair, [answered(), failed()])[0]?.rows[1]?.detail).toBe(
      "run `tentacle serve` in /u/website",
    );
  });

  test("section state + 'N of M projects running' only for M ≥ 2", () => {
    const three = [rec("a", "mac", "a"), rec("b", "mac", "b"), rec("c", "mac", "c")];
    const online = projectSections(three, [answered(), answered([]), failed()])[0];
    expect(online?.state).toBe("online");
    expect(online?.status).toBe("Online · 2 of 3 projects running");
    expect(online?.note).toBeUndefined();
    const one = projectSections([rec("a", "mac", "a")], [answered()])[0];
    expect(one?.status).toBe("Online");
    const attention = projectSections(
      [rec("a", "mac", "a"), rec("b", "mac", "b")],
      [failed({ diagnosis: "revoked" }), failed({ diagnosis: "maybe-reset" })],
    )[0];
    expect(attention?.state).toBe("attention");
  });

  test("zero sessions → new, 'no sessions yet'; counts say 1 session / N sessions / N+ sessions", () => {
    const rows = projectSections(
      [rec("a", "mac", "a"), rec("b", "mac", "b"), rec("c", "mac", "c"), rec("d", "mac", "d")],
      [answered([]), answered([entry()]), answered([entry(), entry()]), answered([entry()], true)],
    )[0]?.rows;
    expect(rows?.map((r) => [r.state, r.detail])).toEqual([
      ["new", "no sessions yet"],
      ["idle", "1 session"],
      ["idle", "2 sessions"],
      ["idle", "1+ sessions"],
    ]);
  });

  test("a row with NO probe result yet is `checking`, never 'the computer does not answer' (mutation: project an absent observation as unreachable → red)", () => {
    // The Computers screen now draws its rows from the records BEFORE the probes
    // land (docs/fix/mobile-project-first-tap.md): every row it does not have an
    // observation for is one still being checked.
    const waiting = projectSections([rec("a", "mac", "tentacle")], [])[0];
    expect(waiting?.rows[0]?.state).toBe("checking");
    expect(waiting?.rows[0]?.word).toBe("Checking…");
    expect(waiting?.rows[0]?.detail).toBe("");
    expect(waiting?.rows[0]?.ok).toBe(false);
    expect(waiting?.rows[0]?.tone).toBe("wait");
    // Not dimmed with the dashed folder of a row that does not answer.
    expect(waiting?.rows[0]?.muted).toBe(false);
    expect(waiting?.state).toBe("checking");
    expect(waiting?.status).toBe("Checking…");
    // The offline explanation ("None of its projects answers") is a CLAIM: only
    // once a probe actually failed.
    expect(waiting?.note).toBeUndefined();
    // Partly probed: the answered one keeps its state, the other is still checking.
    const mixed = projectSections([rec("a", "mac", "a"), rec("b", "mac", "b")], [answered()])[0];
    expect(mixed?.rows.map((r) => r.state)).toEqual(["idle", "checking"]);
    expect(mixed?.state).toBe("online");
  });

  test("a legacy record (no project/computerId) is its own computer, labelled by its last session's folder, else its name", () => {
    const legacy: ProjectRecordLike = { id: "mac", name: "MacBook" };
    const sections = projectSections(
      [legacy, rec("mac.2", "mac", "assistant")],
      [answered([entry({ cwd: "/u/tentacle" })]), answered()],
    );
    // computerIdOf(legacy) === its id, so the project record joins its section.
    expect(sections.map((s) => s.computerId)).toEqual(["mac"]);
    expect(sections[0]?.rows.map((r) => r.label)).toEqual(["tentacle", "assistant"]);
    expect(projectSections([legacy], [failed()])[0]?.rows[0]?.label).toBe("MacBook");
  });
});

describe("what a tap does (docs/fix/mobile-project-first-tap.md: a silent re-probe is not an answer)", () => {
  const rows = projectSections(
    [
      rec("working", "mac", "working"),
      rec("stopped", "mac", "stopped"),
      rec("unreachable", "mac", "unreachable"),
      rec("revoked", "mac", "revoked"),
      rec("reset", "mac", "reset"),
      // LAST, and with no observation: still being checked.
      rec("waiting", "mac", "waiting"),
    ],
    [
      answered([entry({ running: true })]),
      failed({ absent: true }),
      failed(),
      failed({ diagnosis: "revoked" }),
      failed({ diagnosis: "maybe-reset" }),
    ],
  ).flatMap((s) => s.rows);
  const rowOf = (id: string): ProjectRow => {
    const found = rows.find((row) => row.id === id);
    if (found === undefined) {
      throw new Error(`no row ${id}`);
    }
    return found;
  };

  test("open an answering row; wait for the probe on checking/stopped/unreachable; the menu only for a pairing problem (mutation: one arm for every non-ok row → red)", () => {
    expect(rowOf("working").state).toBe("working");
    expect(projectTap(rowOf("working"))).toBe("open");
    expect(rowOf("waiting").state).toBe("checking");
    expect(projectTap(rowOf("waiting"))).toBe("reprobe");
    expect(rowOf("stopped").state).toBe("stopped");
    expect(projectTap(rowOf("stopped"))).toBe("reprobe");
    expect(projectTap(rowOf("unreachable"))).toBe("reprobe");
    expect(projectTap(rowOf("revoked"))).toBe("menu");
    expect(projectTap(rowOf("reset"))).toBe("menu");
  });

  test("the wait a tap started: open only if the row answers now — gone, still down, or needing a pairing retries the list (mutation: trust the asked row → red)", () => {
    expect(tapSettled(rowOf("working"))).toBe("open");
    // Removed / revoked while the person waited: the row is gone, or no longer
    // the thing they tapped.
    expect(tapSettled(undefined)).toBe("retry");
    expect(tapSettled(rowOf("unreachable"))).toBe("retry");
    expect(tapSettled(rowOf("waiting"))).toBe("retry");
    expect(tapSettled(rowOf("revoked"))).toBe("retry");
  });

  test("a wait the person has moved on from does NOTHING — not even if the row answers (mutation: ignore `superseded`/`backgrounded` → red)", () => {
    // Review round 1's MEDIUM: tap unreachable A, then tap working B (B opens);
    // A's probe answers and A's screen yanked the person off B's. The screen
    // bumps a generation on every tap/menu/Add/Pair and on blur, and the wait
    // compares it — so an answering row that arrived after that is `drop`.
    expect(tapSettled(rowOf("working"), { superseded: true })).toBe("drop");
    // …and coming back to the app is not the same tap: still`drop`.
    expect(tapSettled(rowOf("working"), { backgrounded: true })).toBe("drop");
    expect(tapSettled(undefined, { superseded: true })).toBe("drop");
    // A still-down row is left to the 15 s reconsideration, never re-navigated.
    expect(tapSettled(rowOf("unreachable"), { superseded: true })).toBe("drop");
  });

  test("a tap that waits is bounded: `TAP_WAIT_MS` is what the screen arms, and it is short enough to feel like a response", () => {
    expect(TAP_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(TAP_WAIT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("reprobeDelay (Owner Q12: 15 s while something is down)", () => {
  test("15 s with a stopped/unreachable row; never when all answer; sooner for a fading 'Paired just now' (mutation: never re-probe → red)", () => {
    const pair = [rec("p", "mac", "a"), rec("q", "mac", "b")];
    expect(reprobeDelay(projectSections(pair, [answered(), failed()]), 0, undefined)).toBe(
      REPROBE_MS,
    );
    expect(reprobeDelay(projectSections(pair, [failed(), failed()]), 0, undefined)).toBe(
      REPROBE_MS,
    );
    expect(
      reprobeDelay(projectSections(pair, [answered(), answered()]), 0, undefined),
    ).toBeUndefined();
    const last = { id: "p", at: 1_000 };
    expect(reprobeDelay(projectSections(pair, [answered(), answered()]), 2_000, last)).toBe(
      JUST_PAIRED_MS - 1_000,
    );
    expect(
      reprobeDelay(projectSections(pair, [answered(), answered()]), 9_000, last),
    ).toBeUndefined();
  });
});

describe("wasBackgrounded (a wait must not act on a screen the person left)", () => {
  test("only `active` is in front; an unknown state is not a reason to drop (mutation: treat `undefined` as backgrounded → red)", () => {
    expect(wasBackgrounded("active")).toBe(false);
    expect(wasBackgrounded("background")).toBe(true);
    expect(wasBackgrounded("inactive")).toBe(true);
    expect(wasBackgrounded(undefined)).toBe(false);
    // RN types `AppState.currentState` as `string | null` before it is known.
    expect(wasBackgrounded(null)).toBe(false);
  });
});

describe("justPaired (4 s)", () => {
  test("true only for that id, within the window", () => {
    const last = { id: "a", at: 1_000 };
    expect(justPaired("a", last, 1_000)).toBe(true);
    expect(justPaired("a", last, 1_000 + JUST_PAIRED_MS - 1)).toBe(true);
    expect(justPaired("a", last, 1_000 + JUST_PAIRED_MS)).toBe(false);
    expect(justPaired("b", last, 1_000)).toBe(false);
    expect(justPaired("a", undefined, 1_000)).toBe(false);
    const rows = projectSections([rec("a", "mac", "a")], [answered()], {
      now: 2_000,
      justPaired: last,
    });
    expect(rows[0]?.rows[0]?.justPaired).toBe(true);
  });
});
