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

interface Sent {
  readonly prompt: string;
  readonly skill: string | undefined;
}

/** A session that records each `send` and ends the turn at once (or holds it until aborted). */
function recordingSession(sent: Sent[], hold = false): () => SessionController {
  return () => ({
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
      <App createSession={recordingSession(sent)} skills={() => SKILLS} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent)} skills={() => SKILLS} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent)} skills={() => SKILLS} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent)} skills={() => ordered} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent)} skills={() => SKILLS} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent, true)} skills={() => SKILLS} model="m" cwd="/w" />,
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
      <App createSession={recordingSession(sent)} skills={() => SKILLS} model="m" cwd="/w" />,
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

  test("the catalog getter is read live: a skill added after mount is usable", async () => {
    const sent: Sent[] = [];
    let catalog: { name: string; description: string }[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession(sent)} skills={() => catalog} model="m" cwd="/w" />,
    );
    await delay(30);
    await typeAndSubmit(stdin, "/deploy-app");
    expect(lastFrame()).toContain("Unknown command: /deploy-app");
    catalog = SKILLS; // a reconnect's handshake refreshed it
    await typeAndSubmit(stdin, "/deploy-app");
    expect(sent).toEqual([{ prompt: "/deploy-app", skill: "deploy-app" }]);
    unmount();
  });

  test("200 skills: a bare / shows at most PALETTE_MAX_ROWS rows and the input stays on screen", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }));
    const { stdin, lastFrame, unmount } = render(
      <App createSession={recordingSession([])} skills={() => many} model="m" cwd="/w" />,
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
