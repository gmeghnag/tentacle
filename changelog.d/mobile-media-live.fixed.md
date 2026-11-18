- **A photo message on the phone now shows its reply, its picture, and a WhatsApp-shaped bubble — and photos go out
  smaller.** A message with a photo no longer leaves the header on "Running" with no answer: the outbox opened a
  second session handle for the same id, and the client hands the stream to whichever handle opened last, so the
  finished turn's reply and its `turn_end` never reached the transcript (the reply was in the history all along). A
  photo the phone just sent now draws the picture it sent — full bubble width with the bubble's radius, its caption
  below it and no empty text area — and tapping it opens it full screen. The transcript also pulls to refresh, re-reading
  the session from the daemon and replacing the rows: the recovery that used to mean leaving and re-entering. And a photo
  is downscaled to a 2048 px long edge at JPEG 0.8 before upload (a few hundred KB instead of several MB), with a new
  Settings switch, **Send photos at original size**, off by default. The resize names one edge only, so a rotated
  portrait photo is never squashed. The phone's copy of a sent photo is now kept (the transcript's own row draws it) and
  the folder is trimmed on a weekly grace window instead of deleted the moment the daemon accepted the message, so a
  photo that goes bad on disk turns the bubble back into its label rather than an empty frame.
