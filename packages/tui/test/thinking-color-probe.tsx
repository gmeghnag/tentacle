// Child process for thinking-color.test.ts: chalk bakes in its colour level at
// import, so FORCE_COLOR must be set before Ink loads (the parent spawns us with it).
import { render } from "ink-testing-library";
import { Thinking } from "../src/components/Thinking.tsx";

const { lastFrame, unmount } = render(<Thinking since={Date.now()} label="Working…" />);
process.stdout.write(JSON.stringify({ frame: lastFrame() ?? "" }));
unmount();
