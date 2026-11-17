- **A real flowchart draws in the TUI instead of falling back to "source only".**
  The owner's transformer diagram (`subgraph id ["a long title"]`, 22 boxes,
  `<br/>` labels, `[[ … ]]` subroutines, back edges) came back as highlighted
  source because the renderer refused it. Now: a subgraph's title is read without
  its id (and a too-long title is shortened with `…` on whichever border has room
  instead of dropping the whole frame), a label's `<br/>` breaks are drawn as
  several rows in one box and a long label is wrapped to the terminal width, and
  `[[ … ]]` is a subroutine shape. When a diagram genuinely cannot be drawn, the
  caption says why — `too wide for 80 cols — widen the window or ^X^O`, `too many
  boxes to draw`, `cannot draw faithfully in a terminal` — instead of a bare
  "source only in the terminal".
