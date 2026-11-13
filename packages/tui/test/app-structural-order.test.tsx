/**
 * docs/feat/app-decomposition.md S0b (Fable H1) — App's EFFECT ORDER at mount.
 *
 * React runs a component's `useEffect`s in declaration order. App keeps all 20
 * effects in the component, in today's order, precisely because one hook per
 * concern cannot preserve an interleaved order (H1): a slice that moved the
 * session link's watch into `useSessionLink` would place it before the turn
 * driver's initial prompt.
 *
 * The two orders are OBSERVABLY different, and not by accident of timing: the
 * watch subscribes, and a client hands over the turns this TUI missed as a
 * `history` activity. Today the initial-prompt effect runs FIRST, so that
 * history is delivered while the prompt's turn is streaming; `nextStep`
 * (turn-feed.ts) HOLDS a replacing history until the run settles, then applies
 * it — so the replayed rows survive and the transcript is the replay. With the
 * watch first, the history is applied with nothing in flight, and the prompt's
 * turn is then appended BELOW the replay.
 *
 * So the pinned property is *which of the two won*: the replayed rows are on
 * screen exactly once, and the prompt's turn is not (it was replaced by the
 * replay it was held behind). Reordering the two effects turns the second half
 * of this test red — shown as mutation M1 in the slice's Execution.
 *
 * The `send` count is pinned with it (the plan's "surviving rows + `send`
 * count"): the prompt is sent ONCE, as a prompt, and an effect reorder must not
 * turn it into a wake or a re-send.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { SessionActivity } from "../src/turn-feed.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A message of the session's replayed history (the `history` activity's payload). */
const msg = (role: "user" | "assistant", text: string): ChatMessage =>
  ({ role, content: text }) as unknown as ChatMessage;

const REPLAY: readonly ChatMessage[] = [
  msg("user", "older question"),
  msg("assistant", "older answer"),
];

/**
 * A session whose `watch` hands over the history backlog at subscribe (what a
 * client does for the turns it missed), and whose `send` streams a turn that
 * takes a couple of ticks — long enough for the mount effects' order to decide
 * whether that history lands while the turn is in flight (held, then applied
 * over it) or with nothing in flight (applied, then the turn appended).
 */
function fake(): { session: SessionController; sends: string[] } {
  const sends: string[] = [];
  const session = {
    async *send(prompt: string) {
      sends.push(prompt === "" ? "(continuation)" : prompt);
      await delay(20);
      yield { type: "text", delta: "reply to the first prompt" };
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch(listener: (activity: SessionActivity) => void) {
      listener({ kind: "history", messages: REPLAY, reason: null });
      return () => {};
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
  return { session, sends };
}

/** The 0-based screen row holding `needle`, or -1 (the frame is the whole screen). */
const rowOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((line) => line.includes(needle));

describe("S0b effect order: a mount effect runs in the position App declares it", () => {
  test("mount order: the initial prompt starts before the session link is watched, so the replayed history is HELD behind its turn and replaces it", async () => {
    const f = fake();
    const app = render(
      <App createSession={() => f.session} model="m" cwd="/tmp/work" initialPrompt="fix the bug" />,
    );
    await delay(400);
    const frame = app.lastFrame() ?? "";

    // Sent once, as a prompt: never re-sent, never turned into a wake.
    expect(f.sends).toEqual(["fix the bug"]);

    // The replay arrived, in order, exactly once (the held history was applied
    // once — a re-order that applied it twice would show it twice).
    const older = rowOf(frame, "older question");
    const olderAnswer = rowOf(frame, "older answer");
    expect(older).toBeGreaterThanOrEqual(0);
    expect(olderAnswer).toBeGreaterThan(older);
    expect(frame.split("older question").length - 1).toBe(1);

    // …and it replaced the transcript AFTER the prompt's turn ran: the turn's
    // rows are gone, because the history it was held behind replaced them.
    // TODAY'S ORDER, pinned deliberately (H1): with the watch effect first the
    // history lands with nothing in flight and the turn is appended below it,
    // so both rows below would be present. A slice that intentionally changes
    // this behaviour updates this pin together with the change — that is what
    // a characterization net is for.
    expect(rowOf(frame, "fix the bug")).toBe(-1);
    expect(rowOf(frame, "reply to the first prompt")).toBe(-1);
    app.unmount();
  });
});
