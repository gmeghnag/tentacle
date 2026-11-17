- **A write inside the project is no longer refused when the machine is briefly
  out of file descriptors.** The write-confinement check resolves both the target
  and the workspace root to their real paths, and it treated *any* failure to do
  so as "this path does not resolve": on a loaded machine `realpath` fails with
  `EMFILE`, so the check compared a lexical `/var/…` target with a realpath'd
  `/private/var/…` root (macOS) and refused a write that was plainly inside the
  workspace. A transient failure (anything that is not a verdict about the path)
  is now retried, and if it persists it is reported as a refusal to try again —
  never silently read as a path that does not exist, and never as a lexical
  fallback. This also removes the flakiest failures of the main gate.
