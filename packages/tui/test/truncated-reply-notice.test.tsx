/**
 * The owner's two symptoms, on the REAL interface: frames of the real `App`
 * via ink-testing-library (docs/fix/truncated-reply-silent.md; the pattern of
 * `app.test.tsx`).
 *
 * 1. a reply cut at the model's output limit showed the partial text as if it
 *    were the complete answer — no notice at all;
 * 2. a turn that produced nothing showed `› hi` and then NOTHING: no error, no
 *    notice, no `stopped` line. The owner read it as hung.
 *
 * These drive a `createSession` whose events are the ones the agent loop
 * actually yields (the reducer's real input), so the notice is pinned where the
 * user sees it. RED before the fix: both frames are blank in exactly the place
 * the assertions look.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A session that yields `events` on send and then ends, exactly as the loop
 * does: text, the notice of this fix, then `turn_end`.
 */
const sessionOf = (events: readonly AgentEvent[]) => () => ({
  async *send(): AsyncGenerator<AgentEvent> {
    for (const event of events) {
      yield event;
    }
  },
});

/** Submit `prompt` and return every frame the App rendered. */
async function framesFor(events: readonly AgentEvent[], prompt = "hi"): Promise<string> {
  const app = render(<App createSession={sessionOf(events)} model="qwen3" cwd="/tmp/work" />);
  try {
    await delay(30);
    app.stdin.write(prompt);
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    return app.frames.join("\n");
  } finally {
    app.unmount();
  }
}

describe("a reply cut at the output limit (case 1)", () => {
  test("the partial text is shown, AND the user is told it is incomplete", async () => {
    const frames = await framesFor([
      { type: "text", delta: "la vera soluzione" },
      { type: "truncated_reply", reason: "length" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    // The text the model managed is still there (never dropped: it is work).
    expect(frames).toContain("la vera soluzione");
    // ...and it is no longer presented as a complete answer.
    expect(frames).toContain("cut at the model's output limit");
    expect(frames).toContain("incomplete");
    expect(frames).toContain("asking it to continue");
  });

  test("a notice survives to the LAST frame, not only a transient one", async () => {
    // The reported failure was a screen that stayed silent; a notice scrolled
    // out of the running region would be the same bug with extra steps.
    const app = render(
      <App
        createSession={sessionOf([
          { type: "text", delta: "cut here" },
          { type: "truncated_reply", reason: "length" },
          { type: "turn_end", reason: "end_turn" },
        ])}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(200);
      const last = app.lastFrame() ?? "";
      expect(last).toContain("incomplete");
      expect(last).toContain("cut here");
    } finally {
      app.unmount();
    }
  });

  test("an empty reply cut by 'length' is described as such, not as a short answer", async () => {
    const frames = await framesFor([
      { type: "truncated_reply", reason: "length" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    // Nothing was shown for this round, so the notice must not claim an answer
    // was cut: "the model returned nothing" is the honest sentence.
    expect(frames).toContain("returned nothing");
    expect(frames).toContain("output limit");
    expect(frames).not.toContain("this answer is incomplete");
  });

  test("ONE notice per turn, however many cut rounds preceded it", async () => {
    // The re-ask round cuts again (a full context re-truncates at once), so the
    // loop yields the notice again; the user needs the fact ONCE.
    const app = render(
      <App
        createSession={sessionOf([
          { type: "text", delta: "la vera" },
          { type: "truncated_reply", reason: "length" },
          { type: "text", delta: " soluzione" },
          { type: "truncated_reply", reason: "length" },
          { type: "turn_end", reason: "end_turn" },
        ])}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(200);
      const last = app.lastFrame() ?? "";
      const occurrences = last.split("cut at the model's output limit").length - 1;
      expect(occurrences).toBe(1);
    } finally {
      app.unmount();
    }
  });

  test("a new turn may say it again (the dedupe is per turn, not per session)", async () => {
    const app = render(
      <App
        createSession={sessionOf([
          { type: "truncated_reply", reason: "length" },
          { type: "turn_end", reason: "end_turn" },
        ])}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    try {
      await delay(30);
      for (const _ of [1, 2]) {
        app.stdin.write("hi");
        await delay(20);
        app.stdin.write("\r");
        await delay(200);
      }
      // The LAST frame carries both turns (this session says nothing, so the
      // wording is the "returned nothing" one): one notice per turn.
      const last = app.lastFrame() ?? "";
      expect(last.split("hit its output limit").length - 1).toBe(2);
    } finally {
      app.unmount();
    }
  });
});

describe("a turn that produced nothing (case 4)", () => {
  test("says so, instead of leaving the screen as it was", async () => {
    const frames = await framesFor([
      { type: "context_note", text: "Continue with the task.", reason: "continue" },
      { type: "empty_turn" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    // The loop's own nudge stays hidden (unchanged); the new notice is shown.
    expect(frames).not.toContain("Continue with the task.");
    expect(frames).toContain("empty reply");
    expect(frames).toContain("nothing was produced");
  });

  test("the notice is on the last frame, right after the prompt that produced it", async () => {
    const app = render(
      <App
        createSession={sessionOf([
          { type: "empty_turn" },
          { type: "turn_end", reason: "end_turn" },
        ])}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(200);
      const last = app.lastFrame() ?? "";
      expect(last).toContain("hi");
      expect(last).toContain("empty reply");
    } finally {
      app.unmount();
    }
  });
});

describe("a stream cut with no stop reason (case 2) fails the turn loudly", () => {
  test("the failure is visible, and the partial text is not an answer", async () => {
    // The agent loop throws `ModelStreamCutError`; the App's own error path
    // renders it (as it does for any failed turn — `app.test.tsx` pins that).
    const createSession = () => ({
      async *send(): AsyncGenerator<AgentEvent> {
        yield { type: "text", delta: "la vera" };
        yield { type: "truncated_reply", reason: "cut" };
        throw new Error(
          "the model's stream was cut before the reply finished (no stop reason) — the answer is incomplete",
        );
      },
    });
    const app = render(<App createSession={createSession} model="qwen3" cwd="/tmp/work" />);
    try {
      await delay(30);
      app.stdin.write("hi");
      await delay(20);
      app.stdin.write("\r");
      await delay(200);
      const last = app.lastFrame() ?? "";
      // Both halves: why it is incomplete, and that the turn FAILED.
      expect(last).toContain("stream was cut");
      expect(last).toContain("⚠");
      expect(last).toContain("no stop reason");
    } finally {
      app.unmount();
    }
  });
});
