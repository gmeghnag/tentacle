// Child process for thinking-shimmer-sgr.test.ts — see that file for why.
import { render } from "ink-testing-library";
import { Thinking } from "../src/components/Thinking.tsx";

const FRAMES = 18;

const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="Working…" />);
const frames: string[] = [];
for (let i = 0; i < FRAMES; i++) {
  frames.push(lastFrame() ?? "");
  await Bun.sleep(85);
}
unmount();
process.stdout.write(JSON.stringify({ frames }));
