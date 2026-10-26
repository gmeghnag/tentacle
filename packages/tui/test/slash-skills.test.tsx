/**
 * `/name` in the App (docs/feat/skills-slash.md): the palette lists the
 * daemon's skills, and submitting one sends a STRUCTURED activation.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { PALETTE_MAX_ROWS } from "../src/commands.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const UP = "\u001B[A";
const DOWN = "\u001B[B";

interface Sent {
  readonly prompt: string;
  readonly skill: string | undefined;
}

type Skill = { name: string; description: string };

/**
 * A session that records each `send` and ends the turn at once (or holds it
 * until aborted); its `skills()` answers `catalog()` (read at each ask).
 */
function recordingSession(
  sent: Sent[],
  hold = false,
  catalog: () => readonly Skill[] = () => SKILLS,
): () => SessionController {
  return () => ({
    skills: async () => ({ slash: catalog(), skills: [], problems: [], moreProblems: 0 }),
    async *send(prompt, signal, opts) {
      sent.push({ prompt, skill: opts?.skill });
      yield { type: "text" as const, delta: `ok:${opts?.skill ?? "-"}` };
      if (hold) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      }
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  });
}

const SKILLS = [{ name: "deploy-app", description: "Deploy the app to staging." }];

async function typeAndSubmit(stdin: { write(s: string): void }, text: string): Promise<void> {
  stdin.write(text);
  await delay(30);
  stdin.write("\r");
  await delay(60);
}

describe("App: skills as /name", () => {
  test("typing /dep shows the skill in the palette, with its description", async () => {
    const sent: Sent[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent)} model="m" cwd="/w" />,
    );
    await delay(30);
    stdin.write("/dep");
    await delay(40);
    expect(lastFrame()).toContain("/deploy-app");
    expect(lastFrame()).toContain("Deploy the app to staging.");
    unmount();
  });

  test("submitting /deploy-app to staging sends the typed text WITH { skill } — structured", async () => {
    const sent: Sent[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/deploy-app to staging");
    expect(sent).toEqual([{ prompt: "/deploy-app to staging", skill: "deploy-app" }]);
    expect(lastFrame()).toContain("ok:deploy-app");
    // A plain prompt never carries a skill.
    await typeAndSubmit(stdin, "deploy it");
    expect(sent[1]).toEqual({ prompt: "deploy it", skill: undefined });
    unmount();
  });

  test("palette Enter on the skill runs it with no arguments", async () => {
    const sent: Sent[] = [];
    const { stdin, unmount } = render(
      <App createSession={recordingSession(sent)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/dep");
    expect(sent).toEqual([{ prompt: "/deploy-app", skill: "deploy-app" }]);
    unmount();
  });

  test("Enter on an exactly typed name runs THAT skill, not a longer one listed first", async () => {
    const sent: Sent[] = [];
    const ordered = [
      { name: "deploy-prod", description: "project" },
      { name: "deploy", description: "user" },
      { name: "c", description: "one letter" },
    ];
    const { stdin, unmount } = render(
      <App createSession={recordingSession(sent, false, () => ordered)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/deploy");
    await typeAndSubmit(stdin, "/c");
    expect(sent).toEqual([
      { prompt: "/deploy", skill: "deploy" },
      { prompt: "/c", skill: "c" },
    ]);
    unmount();
  });

  test("an unknown /name (or a path) is still 'Unknown command' and sends nothing", async () => {
    const sent: Sent[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/tmp/x is broken");
    expect(lastFrame()).toContain("Unknown command: /tmp/x");
    await typeAndSubmit(stdin, "/deploy-app/x");
    expect(lastFrame()).toContain("Unknown command: /deploy-app/x");
    expect(sent).toEqual([]);
    unmount();
  });

  test("mid-turn /deploy-app is refused with a notice (not queued as steering)", async () => {
    const sent: Sent[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent, true)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "long task");
    await typeAndSubmit(stdin, "/deploy-app");
    expect(lastFrame()).toContain("Can't run /deploy-app while a turn is running");
    expect(sent).toEqual([{ prompt: "long task", skill: undefined }]);
    stdin.write("\u001B"); // esc: stop the held turn
    await delay(30);
    unmount();
  });

  test("/retry re-sends a skill activation as an activation; ↑ recalls it", async () => {
    const sent: Sent[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/deploy-app go");
    await typeAndSubmit(stdin, "/retry");
    expect(sent).toEqual([
      { prompt: "/deploy-app go", skill: "deploy-app" },
      { prompt: "/deploy-app go", skill: "deploy-app" },
    ]);
    stdin.write(UP);
    await delay(30);
    expect(lastFrame()).toContain("/deploy-app go");
    unmount();
  });

  test("the list is asked again when / is typed: a skill added after mount is usable", async () => {
    const sent: Sent[] = [];
    let catalog: { name: string; description: string }[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent, false, () => catalog)} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/deploy-app");
    expect(lastFrame()).toContain("Unknown command: /deploy-app");
    catalog = SKILLS; // written on disk meanwhile
    await typeAndSubmit(stdin, "/deploy-app");
    expect(sent).toEqual([{ prompt: "/deploy-app", skill: "deploy-app" }]);
    unmount();
  });

  test("200 skills: a bare / shows at most PALETTE_MAX_ROWS rows and the input stays on screen", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }));
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession([], false, () => many)} model="m" cwd="/w" />,
    );
    await delay(30);
    stdin.write("/");
    await delay(40);
    const frame = lastFrame() ?? "";
    const paletteRows = frame.split("\n").filter((l) => /^\s*(❯ )?\/\S+\s{2}/.test(l));
    expect(paletteRows.length).toBe(PALETTE_MAX_ROWS);
    for (let i = 0; i < 12; i++) {
      stdin.write(UP); // wraps to the end of the list
      await delay(5);
    }
    await delay(30);
    const later = lastFrame() ?? "";
    expect(later.split("\n").filter((l) => /^\s*(❯ )?\/\S+\s{2}/.test(l)).length).toBe(
      PALETTE_MAX_ROWS,
    );
    expect(later).toContain("❯ /s"); // the selection is visible
    unmount();
  });
});

/**
 * A session whose first `skills()` answers `alpha` at once and every later
 * one waits for `release()`, then answers `alpha` + `beta` (beta written on
 * disk after the start: `/name` now, the model's at the next reset).
 */
function gatedSession(sent: Sent[]): { create: () => SessionController; release: () => void } {
  const waiting: (() => void)[] = [];
  let asks = 0;
  const alpha = {
    name: "alpha",
    description: "the alpha skill",
    scope: "user" as const,
    user: true,
    model: true,
    location: "/s/alpha/SKILL.md",
  };
  const beta = {
    ...alpha,
    name: "beta",
    description: "the beta skill",
    model: false,
    modelAfterReset: true,
    location: "/s/beta/SKILL.md",
  };
  const answer = (list: (typeof alpha | typeof beta)[]) => ({
    slash: list.map(({ name, description }) => ({ name, description })),
    skills: list,
    problems: [],
    moreProblems: 0,
  });
  return {
    create: () => ({
      skills: async () => {
        if (asks++ === 0) {
          return answer([alpha]);
        }
        await new Promise<void>((resolve) => waiting.push(resolve));
        return answer([alpha, beta]);
      },
      async *send(prompt, _signal, opts) {
        sent.push({ prompt, skill: opts?.skill });
        yield { type: "turn_end" as const, reason: "end_turn" as const };
      },
    }),
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

describe("App: skills follow the disk (docs/feat/skills-hot-reload.md, T7)", () => {
  test("typing / asks again: the popup shows the new skill once the answer lands", async () => {
    const gate = gatedSession([]);
    const { stdin, lastFrame, unmount } = render(
      <App createSession={gate.create} model="m" cwd="/w" />,
    );
    await delay(30);
    stdin.write("/"); // opens the popup: asks again (held)
    await delay(20);
    stdin.write("be");
    await delay(40);
    const before = lastFrame() ?? "";
    expect(before).toContain("❯ /be");
    expect(before).not.toContain("/beta ");
    gate.release();
    await delay(40);
    const after = lastFrame() ?? "";
    expect(after).toContain("/beta");
    expect(after).toContain("the beta skill");
    unmount();
  });

  test("/beta⏎ typed before the fresh list lands still activates beta (resolved again once)", async () => {
    const sent: Sent[] = [];
    const gate = gatedSession(sent);
    const { stdin, lastFrame, unmount } = render(
      <App createSession={gate.create} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/beta go");
    expect(sent).toEqual([]); // waiting for the fresh list, not refused
    gate.release();
    await delay(60);
    // Mutation (red, verified): no resolve-again → "Unknown command: /beta".
    expect(sent).toEqual([{ prompt: "/beta go", skill: "beta" }]);
    expect(lastFrame()).not.toContain("Unknown command");
    unmount();
  });

  test("a word still unknown after the fresh list is refused as before", async () => {
    const sent: Sent[] = [];
    const gate = gatedSession(sent);
    const { stdin, lastFrame, unmount } = render(
      <App createSession={gate.create} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/nope");
    gate.release();
    await delay(60);
    expect(lastFrame()).toContain("Unknown command: /nope");
    expect(sent).toEqual([]);
    unmount();
  });

  test("/skills asks again and marks a skill the model gets at the next reset", async () => {
    const gate = gatedSession([]);
    const { stdin, lastFrame, unmount } = render(
      <App createSession={gate.create} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/skills");
    gate.release(); // the `/` open's ask and the panel's share one request
    await delay(60);
    expect(lastFrame()).toContain("beta");
    stdin.write(DOWN); // the beta row
    await delay(20);
    stdin.write("\r"); // expand it
    await delay(40);
    expect(lastFrame()).toContain("/beta · model: after a context reset");
    unmount();
  });
});
