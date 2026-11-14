- **Mobile transcript model (task 12b).** The Expo app now has its own pure,
  React-free transcript fold — a session's history plus live updates (own and
  foreign turns alike) become renderable rows with markdown, highlighted code,
  tool rows with their diffs and a `denied` state, and the daemon's notices —
  pinned to the TUI's fold by a parity test on shared fixtures, with stream
  batching, bounded parsing and bounded diff rendering so a huge message or a
  fast stream cannot stall the JS thread. Image attachments ride the rows as
  `[image: name]` with a thumbnail policy that only ever fetches the visible
  rows. No screen change yet: this is the model the session screen (12c) renders.
