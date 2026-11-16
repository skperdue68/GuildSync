# ESO account rename implementation plan

**Goal:** Preserve one member across ESO account-name changes.
**Architecture:** Stable identities and unique aliases, canonical operational keys, immutable original-name fields and rename audit. Serialized transactional rename with conflict checks; canonicalized imports and alias-aware search.
**Spec:** ../specs/2026-11-15-eso-account-renames-design.md

- [x] Identity service: startup schema/backfill; strict name validation; preview counts/conflicts and signed actor/session-bound confirmation; atomic reference updates and immutable audit; rollback on failures. Test with real SQLite execution adapter plus lock simulation.
- [x] Ingestion and retrieval: canonicalize roster snapshots/events, banking, applications and link writes under same reentrant lock; aliases resolve old searches; retain original event names; rank restoration and note access use canonical account. Test old snapshots, replay idempotence, applications/banking and collision cases.
- [x] Socket: independently authorize effective approved Admin/User, deny Viewer and bot, bind actor/session from authentication, refresh affected data without automatic linking/promotion. Test permissions and forged/expired confirmations.
- [x] Both clients: member history rename form, preview/confirm/cancel, show conflicts, reset stale requests, rename history row and original-name display. Test parity, viewer restriction and stale callbacks; build both.
- [x] Review complete diff, run relevant tests and broader checks, document migration and rollout, commit feature branch and create production PR. Original GuildSync2 and VSCode checkout stay unchanged.

Review focus: pre-existing target records/aliases, concurrent rename/import, repeated or expired confirmation, old-name replay after restart, effective viewer/impersonation permissions and secret-free audit.

Verification: focused SQL compatibility tests include old-name ingestion, rollback, aliases across startup, expired/stale confirmations, Viewer denial, restricted-note count privacy, deferred onboarding and slow Sheets exports. Independent review found a postcommit Sheets lock hold; both import and manual entry paths now defer network work until the lock/connection is released. Both client builds and the full backend suite were run. Two existing parity failures remain in the baseline; no MariaDB/Discord production calls were made.
