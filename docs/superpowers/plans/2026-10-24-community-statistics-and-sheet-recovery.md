# Community statistics and automatic Sheets recovery

Goal: restore reliable unattended raffle export and add compact, optional-to-open community highlights under Reports and Admin. The user authorized proceeding and invited sensible extra statistics; preserve the primary checkout and deliver one isolated PR.

Design: use existing MariaDB, Socket.IO, Discord bot, and mirrored web/desktop clients. Statistics are read-only for approved viewers/users/admins. Persist Discord command/component usage in a deduplicated table keyed by interaction ID, with guild/user IDs and no command arguments or message content. Label incomplete historical coverage. Derive guild/Discord membership history, current member tenure, current raffle ticket leaders, lifetime raffle spending, and community totals from existing records. Expose one read-only socket report with generatedAt, trackingSince, notes, overview [{label,value}], highlights [{id,title,description,unit,rows:[{name,value,detail}]}].

Sheets: trace current failure path, retain newly inserted raffle transactions in a durable queue in the same database transaction, retry after credential/network failures and restart, and continue using coordinator locking, transaction-ID duplicate checks, and displayed raffle-period gates. Seed pre-upgrade current-period records for recovery, without clearing or resetting spreadsheets. Keep rollover/load/manual behavior compatible. Do not perform live database or spreadsheet writes from development.

Tasks:
1. Backend statistics and usage collection: create tests, migrations/schema startup, report service, bot collection helper, retention/coverage documentation. Do not log private content.
2. UI: collapsible Community highlights card in Reports/Admin, render one report on demand, refresh only that card preserving scroll, no global layout changes; mirror web and desktop. Test missing/empty/multiple leaders and read-only access.
3. Root Sheets recovery: failing tests for committed-but-failed export and restart retry; queue store/worker integration and startup hooks; preserve idempotency and future/historical period gates.
4. Integrate socket authorization and startup hooks; update detailed/user/deployment documentation with new tables and limitations; run focused tests, both builds, full affected suites and inspect existing baseline failures separately.
5. Review final diff, verify primary checkout unchanged, commit/push branch, open pull request. User must restart Linux backend/bot and rebuild clients; Apps Script only if changed.
