// Child process for thinking-shimmer-sgr.test.ts — see that file for why.
import { render } from "ink-testing-library";
import { Thinking } from "../src/components/Thinking.tsx";

const FRAMES = 18;
// Generous cap so a starved child still terminates (the test then fails on the
// frame count, loudly) instead of hanging the gate.
const DEADLINE_MS = 15_000;

const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="Working…" />);
// Capture CONSECUTIVE rendered frames, not wall-clock samples: a fixed sleep under
// a loaded (parallel) gate can land on the same tick twice or skip the sweep
// entirely, so the peak could look frozen. Every tick changes the spinner glyph,
// so "the frame changed" is exactly "one tick rendered".
const frames: string[] = [lastFrame() ?? ""];
const deadline = Date.now() + DEADLINE_MS;
while (frames.length < FRAMES && Date.now() < deadline) {
  await Bun.sleep(5);
  const f = lastFrame() ?? "";
  if (f !== frames[frames.length - 1]) {
    frames.push(f);
  }
}
unmount();
process.stdout.write(JSON.stringify({ frames }));
