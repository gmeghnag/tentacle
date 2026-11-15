- **`move_session` is now OFF by default.** `sessionHop.tool` (env
  `TENTACLE_SESSION_HOP_TOOL`) used to default to on, so a fresh install offered
  the model a tool that proposes moving your session. It is now an opt-in: set
  `sessionHop.tool: true` (or `TENTACLE_SESSION_HOP_TOOL=1`) to offer it. A
  `/move` you type is unaffected — it never needed the setting. `config list` and
  the config reference now say so, and no longer claim a proposed move is "never
  answered by auto-accept" (it is, except toward your own machine).
