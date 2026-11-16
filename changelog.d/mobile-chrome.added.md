- **New session from the phone, and background work you can see and steer.** The sessions
  drawer gains a "New session" pill: it creates an empty session on the computer
  the drawer lists (that computer's own project), opens it with the keyboard up,
  and the first message starts it. The pill is offered only while that computer
  is online; a create that fails says why under it and opens nothing. The chat
  header also gains an **Activity** pill — a spinner and the count of background
  sub-agents and shell jobs still running (or "n new" for a report not yet
  read), shown only when there is something — that opens one Activity sheet:
  Sub-agents (description, `sa-N` · type · steps · elapsed, the latest step),
  Shell jobs (the command, `bg-N` · status · elapsed), Finished (the children
  that ended while you watched, each opening its report, with Copy) and a greyed
  Scheduled for later. An `agent_task` card in the conversation links to its
  child in that sheet. Every row opens: a running child shows its latest steps,
  your messages to it (marked "read" once it has taken them in), a "Message
  sa-N…" field and Stop; a shell job shows its output (pull to refresh) and
  Stop; a finished child's report adds "Show in chat". Stop asks once first,
  and a message or Stop the computer refuses (the child just ended, an older
  computer) says why and keeps what you typed. Settings → Activity button can
  swap the header pill for a floating button (off by default): drag it to
  either edge, it stays there across launches, and it keeps out of the way of
  the composer, the keyboard and open sheets; with VoiceOver it stays put and
  the header pill is shown too.
