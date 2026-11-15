- **Project hooks run in a phone turn.** They silently never did: the daemon
  asked the prompting client and the phone had no answer for that question, so
  every turn in a project with hooks ran without them and said nothing. The
  serve host's own `hooks-trust.json`, the file this machine's TUI writes, is
  now checked first, read-only, so a folder trusted once on that computer runs
  its hooks for every client's turns; a folder it does not trust is asked about
  by the phone, through the permission sheet, which always reaches a person and
  is never answered by auto-accept. Nothing is stored from a phone's answer.
