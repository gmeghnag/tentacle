- **The hub's fan opens smoothly while the model is thinking or answering.** On
  a phone, the fan opened in jerks during a streaming turn: every streamed chunk
  re-rendered the whole chat, and each re-render restarted the fan's opening
  animation (on the simulator, about 400 restarts in one open, so the fan never
  finished opening while the turn streamed). Now the fan starts its animation
  once per open. The chat re-renders at most about 10 times a second while text
  streams, and only the row that changed is redrawn. Turn ends, tool cards and
  permission prompts still show at once. Exported logs now include `ptrace`
  lines: JS frame gaps, whether a turn was streaming, and how long the fan took
  to open. Use them to diagnose jank on a real device.
