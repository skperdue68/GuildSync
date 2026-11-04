# GuildSync General foundation

Production remains on master; Guildsync-General is the long-lived portability integration branch. Feature PRs target Guildsync-General. No automatic back-merge or production deployment is authorized.

1. Start from current production master (1.4.8), retain ancestry, and publish Guildsync-General.
2. Add a branch development guide, explicit upstream sync procedure, and backlog grouped by guild identity, ranks, raffle rules, Sheets layout, welcomes, endpoints and releases.
3. Replace the exact Consigliere raffle-admin checks with a single policy contract mirrored in backend and bot. GUILDSYNC_RAFFLE_ADMIN_ROLES accepts comma-separated names or raw IDs; unset retains Consigliere, explicit blank denies everyone. Match names case-insensitively, IDs exactly. Never infer access from decorative roles or application Admin status.
4. Apply the contract to raffle load/reset/archive/update and ticket verification. Keep server-side raffle-sheet authorization.
5. Test custom names/IDs, defaults, blank denial, no implicit higher-role grant, bot and backend enforcement, and parity of both policy copies.
6. Add General-only CI for these tests and an upstream ancestry check. Before every General feature PR, bring current master into General using a reviewed merge PR; do not squash sync merges because their ancestry is required.
7. Publish a feature PR targeting Guildsync-General. This begins portability; existing guild-specific schedules, templates, ticket rules and layouts remain explicit backlog items.
