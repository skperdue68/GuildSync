# Inline application history implementation plan

User scope: application text belongs directly beneath joined events in member history, with no roster button or extra click. Match the capture date near the join and explicitly show missing text.

- [x] Add an exact-account read query and authenticated socket receiver. Recheck current approved access; permit viewer reads without writes.
- [x] Add tests for exact names, optional @, denied accounts, read policy, and safe database errors.
- [x] Match recorded applications to nearest joins within seven days without reusing applications; test rejoin and distant records.
- [x] Render escaped text, local capture dates, missing text and request failures inline in both clients.
- [x] Run focused regressions and both client builds; inspect full-suite failures against existing baseline.
- [ ] Review the final diff and create an isolated pull request; do not merge.
