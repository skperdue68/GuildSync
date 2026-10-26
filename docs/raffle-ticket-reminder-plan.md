# Public raffle ticket reminder implementation plan

**Goal:** Help readers of public raffle summaries find their current purchases with /tickets.

**Architecture:** Add an opt-in formatter flag, enabled by scheduled summaries and public /raffle replies. Keep private ticket details and supplied archive content unchanged.

**Tech Stack:** JavaScript, node:test, discord.js.

- [x] Add behavior tests for public command and scheduled content, plus private/archive exclusions; observe failure.
- [x] Add minimal formatter flag and enable it at the three public formatting call sites.
- [x] Run focused tests and full bot suite, then commit and open a separate PR.

Validation: all three new behavior tests failed before implementation; focused coverage and the full 134-test bot suite passed. Public summaries opt in; private ticket replies and explicit archive content do not receive the reminder.
