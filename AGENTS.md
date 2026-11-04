# Guildsync-General development

These rules apply to portability work on Guildsync-General and feature branches targeting it.

- Production is master (the repository does not currently have a main branch). Guildsync-General is a separate, long-lived test version.
- Create small feature branches and PRs with base Guildsync-General. Do not target master or back-merge General without the user's explicit request. Do not change the user's IDE checkout.
- Every production fix or feature must be evaluated and brought forward to General through an upstream-sync PR. Prefer merge commits for these PRs, preserving master ancestry; do not squash/rebase upstream syncs. Resolve conflicts explicitly and rerun affected tests.
- Before General work, fetch origin/master and origin/Guildsync-General and check upstream ancestry. If production moved, open/complete its forward-port PR before claiming General is up to date. CI flags stale integration; it does not silently merge code.
- Keep separate test database, ports, Discord application/token/server, OAuth callback, Sheets/Drive files, and deployments. Never use production credentials for portability tests.
- General's production build/publication workflows are disabled deliberately. Do not re-enable them during upstream conflict resolution. Design separate prerelease artifacts before shipping General installers.
- Record remaining assumptions and test steps in docs/GuildSync-General.md. Preserve the existing guild's configuration as defaults until an explicit migration changes them.
- Backend and bot raffle-permissions.js are mirrored to avoid a new cross-package deployment dependency; their parity test must pass.
