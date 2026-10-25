# Late deposit spreadsheet recovery

Scope: include deposits made before the ticket cutoff when uploaded during the archive hold. Keep deposit-time assignment, archive timing, and reminder behavior unchanged.

- [x] Reproduce the held-write rejection and missing prearchive database replay with fake Google requests.
- [x] Permit period-filtered ordinary exports while an archive is waiting but has not started copying.
- [x] Before copying, replay database entries selected using the persisted source windows while holding the spreadsheet lock. Fail closed if replay fails; preserve archive/reset retry behavior.
- [x] Test cutoff boundaries, restart recovery, duplicates, and replay failure. Run the backend suite; report existing failures.
- [ ] Commit and publish one focused PR.

Validation: focused Sheets/raffle suite passes. Full backend suite: 374 tests, 372 pass; existing mirror failures are `desktop and web share the same account editor and styles` and `backend and both clients use the same role/event policy`. Browser and local HTTP tests require an unrestricted run; ignored `web/dist` artifacts were populated from the matching served `public` bundle for the bundle check. No live Google requests.

Queue recovery records completion only after confirmed Google writes or IDs read back from the original source, including prearchive replay. Failed writes leave the queue pending and stop archive/reset. No Apps Script deployment is required.
