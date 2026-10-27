# Public raffle ticket reminder implementation plan

**Goal:** Help readers of public raffle summaries find their current purchases with /tickets.

**Architecture:** Add an opt-in formatter flag, enabled by scheduled summaries and public /raffle replies. Keep private ticket details and supplied archive content unchanged.

**Tech Stack:** JavaScript, node:test, discord.js.

- [x] Add behavior tests for public command and scheduled content, plus private/archive exclusions; observe failure.
- [x] Add minimal formatter flag and enable it at the three public formatting call sites.
- [x] Run focused tests and full bot suite, then commit and open a separate PR.

Validation: all three new behavior tests failed before implementation; focused coverage and the full 134-test bot suite passed. Public summaries opt in; private ticket replies and explicit archive content do not receive the reminder.

## Plain /raffle follow-up (October 27, 2026)

Plain `/raffle` now opts into the same `/tickets` reminder, while retaining its
private response. `/tickets`, `/raffle tickets:true`, and verification responses
omit the note because they already display ticket information. Public summaries,
scheduled posts, archive notifications, and channel cleanup keep their behavior.

The expanded command regression failed before the one-condition change and passed
afterward. All 139 bot tests passed. Deploy the updated Discord bot and restart
`guildsync-bot`; no backend, frontend, environment, or Apps Script update is needed.
