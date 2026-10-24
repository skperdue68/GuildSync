# Community highlights and automatic spreadsheet recovery

## Community highlights

Open Reports and Admin, then Community highlights. The section loads on demand and Refresh updates only its results, preserving the page position. All approved Viewer, User, and Admin accounts can read it. No editing or account management privileges are granted by this report.

Highlights include the most recorded guild joins and departures (including kicks), Discord joins/departures, longest and newest recorded current guild memberships, Discord interaction leaders, most-used bot commands, current Bi-Weekly and 50/50 purchased-ticket leaders, and lifetime recorded raffle spending. Community totals show current roster sizes, recorded interactions, and raffle spending.

Colors, other report sections, and the main roster/banking screens are unchanged. The section uses the existing Reports accordion. Cached results and pending requests are discarded when the authenticated session changes.

### What the numbers mean

- These are rankings from retained GuildSync records, not claims of complete all-time history.
- Membership tenure uses actual recorded join events and current roster membership. Snapshot capture dates are not treated as real join dates. Missing joins/departures can leave people unranked or affect recorded tenure.
- Bulk Discord imports are excluded from join counts. Existing live history can treat first discovery during an update as a join; the report discloses that limitation.
- Raffle purchasers are grouped by ESO account, ignoring case. Current-period leaders use existing raffle sales windows. Purchased tickets exclude bonus tickets; zero-ticket donations are excluded from purchase spending. Gold totals remove the +1/+3 raffle markers and exclude future-dated transactions.
- New activity tracking counts slash-command requests, buttons, selects, and modals handled by this GuildSync bot. It does not count all Discord messages or commands belonging to other bots. A failed command can still count as a request. Offline or failed telemetry deliveries are not backfilled.
- Tracking starts when the backend schema is first initialized. Old command usage cannot be reconstructed automatically.

The activity table stores Discord interaction/guild/user IDs, display names, interaction kind, slash command name, and collection time. It does not store command arguments, message text, component IDs, selected values, or modal contents. Interaction IDs prevent duplicate counting. Records are retained until explicitly removed; access requires the authenticated GuildSync bot for writes and currently approved GuildSync access for reports.

## Automatic raffle spreadsheet recovery

Previously a deposit could commit to MariaDB, fail its immediate Google write, and never retry because later file uploads were duplicates. The backend now queues the spreadsheet export in the same transaction as the banking insert. Manual entries use the same durable transaction boundary, including when ordinary exports are temporarily disabled.

Immediate exports still run normally. A background worker checks pending exports every minute, with retry delays from one minute up to one hour. Failure of credentials, network, or Google requests leaves the item pending across backend restarts. Re-enable exports to allow pending writes to resume; disabled exports make no Google requests.

At startup (or the first enable for that running worker), existing current-period database entries are also queued for recovery. The worker checks the sheet transaction IDs and appends only missing entries. It does not reset sheets, erase data, create archives, change draw dates, or replay all historical raffle purchases. Existing coordinator/database locks and displayed raffle-date guards still apply. Entries outside the displayed period stay in the database and queue; archive/load remains responsible for historical periods. A Google-confirmed batch or an ID already read from the sheet completes the queue entry. A duplicate reserved only inside an unsubmitted batch is not acknowledged early.

The queue is keyed by spreadsheet ID plus transaction ID. Completed rows are retained so restart backfill does not repeatedly enqueue completed work. They are an export ledger, not a replacement for banking or archive history. Manual clear/refresh commands retain their existing behavior.

### Linux credential checks

If the credential path changed during migration, edit the backend .env and restart the backend. With the default service working directory, a credential file alongside the backend can use:

```env
GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_FILE=./guildsync-service-account.json
```

The file must be readable by the service user, and the service-account email must have edit access to the spreadsheet. A nonempty GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON takes precedence over the file setting. Existing GuildSync administrator overrides can also disable ordinary Google Sheets writes even when the .env default is enabled.

Review recent Linux logs without sharing credential-file contents:

```bash
sudo journalctl -u guildsync-backend -n 100 --no-pager
```

Look for Export stopped, Automatic spreadsheet export will retry, Automatic spreadsheet recovery confirmed, and the Google error or missing-file path. A blank/invalid working draw date or a deposit assigned to a different raffle intentionally prevents an append.

### Database tables and deployment

Startup creates these tables idempotently:

| Table | Purpose |
| --- | --- |
| guildsync_sheets_export_queue | Per-spreadsheet transaction export state, attempt count, retry time, last error, completion time. |
| guildsync_discord_interactions | Deduplicated Discord bot usage metadata. |
| guildsync_community_statistics_metadata | Persistent tracking start time. |

Read-only queue review:

```sql
SELECT spreadsheet_id, event_id, status, attempts,
       FROM_UNIXTIME(next_attempt_at) AS next_retry, last_error
FROM guildsync_sheets_export_queue
ORDER BY status, next_attempt_at, event_id;
```

Back up the database, deploy the updated backend and bot, restart both, and rebuild/deploy the web and desktop clients. Existing Linux installations extracted from a server ZIP need the updated server files or a newly built server release; git pull does not update a directory that was never cloned. No new dependency, slash-command registration, Google Apps Script update, or new environment setting is required. Schema setup runs as part of ordinary startup.

Tests simulate Google/database failures and cannot establish that a production spreadsheet is writable. Confirm a real eligible deposit appears on the working sheet after deployment and review the queue/logs if it does not.
