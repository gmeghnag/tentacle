// NO_COLOR: the label must be the plain, flat accent run it has always been —
// the sweep is invisible, not a different layout. Runs colour-off (the default
// for a non-TTY, which is what NO_COLOR also yields).
import { render } from "ink-testing-library";
import { Thinking } from "../src/components/Thinking.tsx";

const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="Working…" />);
const frames: string[] = [];
for (let i = 0; i < 6; i++) {
  frames.push(lastFrame() ?? "");
  await Bun.sleep(85);
}
unmount();
process.stdout.write(JSON.stringify({ frames, level: (await import("chalk")).default.level }));
