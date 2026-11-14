- **Mobile composer queue model (task 13a).** The Expo app gains its own pure,
  React-free decision module for the rows above the session input: the daemon's
  queue merged with the phone's own not-yet-acked rows, whose row belongs to
  which writer, the send-now take and its refusal restore, and the hand-back
  that puts a returned row back into the field once — banner included — before
  reclaiming it, keyed on a persisted own-id set so a row queued by a killed
  earlier app still finds its way home, while another device's returned row is
  offered with an explicit Take. Pinned to the TUI's and the client's rules by
  parity tests. No screen change yet: this is the model the composer (13d)
  renders.
