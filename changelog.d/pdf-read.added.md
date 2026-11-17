- **Read PDFs.** `fs_read` extracts a PDF's text natively (page markers,
  `pages` ranges, a clear "scanned, no OCR" verdict); attach a PDF from the TUI
  or the iPhone — the `+` sheet's **File (PDF)** — and the model reads it as
  delimited `<file …>` data, while the message itself shows the file's name
  instead of its text.
