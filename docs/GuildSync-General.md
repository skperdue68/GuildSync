# GuildSync General: portability development

Guildsync-General is a long-lived development/testing branch in skperdue68/GuildSync. It started from production master at bdc17cc (GuildSync 1.4.8). Production continues on master. This is not a finished general-purpose release.

## Branch and review process

Create feature PRs targeting Guildsync-General. Do not open the whole General branch as a merge into master. Each portability task gets a small PR. The branch stays separate until the owner explicitly approves integration.

Bring ongoing production changes forward through a PR with base Guildsync-General and head master (or a temporary conflict-resolution branch created from General that merges master). Merge that sync PR with a merge commit so ancestry is retained. Resolve configuration/release-workflow conflicts in favor of General's isolation. Rerun affected tests. Do not squash/rebase upstream-sync merges. General CI checks that current origin/master is an ancestor; a stale result requires this forward-port, not a bypass. There is no unattended synchronization or automatic production deployment.

Example GitHub CLI command, after comparing current branches:

```sh
gh pr create --repo skperdue68/GuildSync --base Guildsync-General --head master --title "Sync production changes into Guildsync-General" --body "Bring current production fixes forward; review conflicts and run General checks. Merge with a merge commit."
```

## First configurable permission

Set the same optional environment value in BOTH backend and Discord bot:

```dotenv
GUILDSYNC_RAFFLE_ADMIN_ROLES=Officers,Raffle Managers
```

Use comma-separated Discord role names (case-insensitive) or raw numeric role IDs. Do not include @ or mention syntax. IDs continue working after a role rename. Unset retains Consigliere for compatibility. Explicitly blank disables access for everyone. Specified roles replace the default; Kingpin/Administrator/higher rank does not implicitly grant access. List every role that should be allowed. Restart both services after changes; this first setting has no web override yet.

The policy controls /gsraffle and /gsr load/reset/archive/update and /tickets verify or /raffle verify. Ordinary ticket lookups remain available. Backend sheet authorization uses synced Discord roles independently of the bot's local check. Keep role synchronization healthy; mismatched backend/bot settings can deny an operation. Other officer policies (applications, notes, promotion and mute) are still separate and will be generalized later.

## Separate test installation

Use a separate database and backend/bot instance, ports, test Discord application/token and server, OAuth redirect, and service account/Sheets/Drive test files. Do not copy production secrets into this branch or run destructive raffle tests against live sheets. Existing per-guild identity protection remains in force. Test with a second guild whose role names differ.

Production release jobs in General's workflow copies are disabled, including reusable download publication. The production workflow on master is unchanged. General CI currently verifies upstream ancestry and permission behavior; native testing remains in its existing workflow. Test installers, separate identity/cache/storage, and a distinct artifact/version channel are future work. Do not create a public General release with the production packaging pipeline.

## Portability checklist

- [x] Dedicated branch based on latest production; review/sync policy and CI guard.
- [x] Configurable raffle administrator/verification roles by name or ID, backend and bot.
- [ ] Guild setup wizard/default identity and neutral addon defaults; retain /gsb guild, /gsr guild and /gsa guild selection.
- [ ] One rank mapping and ordered hierarchy for filters, notes, permissions, returning-member restoration, onboarding and mute; arbitrary rank counts.
- [ ] Ticket prices/deposit flags shared consistently between ESO, backend, receipts and Discord.
- [ ] Configurable raffle types, recurrence, calendar anchor, timezone, cutoff and draw time, preserving DST correctness.
- [ ] Configurable Sheets template layout, result fields and archive naming, synchronized with Apps Script.
- [ ] Neutral welcome/email defaults, guild identity and links; retain editable templates.
- [ ] Endpoint selection and standalone installation configuration without perdues.me fallbacks.
- [ ] Separate test distribution, desktop app data/session identity and release artifacts.
- [ ] End-to-end validation with a different guild, roles, schedule and spreadsheets.

One backend/bot/database per guild remains the initial supported model. Multi-tenant shared databases are out of scope. Production fixes must be forward-ported throughout this work.
