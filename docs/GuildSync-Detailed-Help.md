# GuildSync detailed help and operator reference

For the optional Windows voice shortcut, configuration, database tables and recovery rules, see [Voice Channel Mute](GuildSync-Voice-Mute.md).

Updated October 5, 2026. This reference follows the current implementation, including optional onboarding and voice hotkeys. Deploy the relevant merged changes before relying on a feature. Application/add-on versions are managed by `tools/update-version.go`; deploying backend/bot changes is separate from packaging a desktop release.

For everyday use, start with the [user guide](GuildSync-User-Guide.md). This document covers command access, data flows, configuration, persistence, and recovery.

The avatar menu provides admin-only **Manage GuildSync Users**, including approval, profile and role edits, removal, and pending counts. See [user administration](GuildSync-User-Administration.md) for server authorization, session invalidation, existing database tables, and deployment details.

See [GuildSync account roles](GuildSync-Roles.md) for the Viewer/User/Admin permissions matrix and Admin preview modes. Viewer is the default for new pending accounts after initial Admin bootstrap. Viewers can read data and ingest ESO history but cannot manually edit records or process receipts; backend socket checks enforce this distinction. Existing account roles are preserved. Login-database startup updates only the role column's insertion default.

## Contents

- [System overview](#system-overview)
- [Discord command reference](#discord-command-reference)
- [ESO command reference](#eso-command-reference)
- [Banking, spreadsheets, archives, and updates](#banking-spreadsheets-archives-and-updates)
- [Raffle bonus tickets and receipts](#raffle-bonus-tickets-and-receipts)
- [Discord links and onboarding](#discord-links-and-onboarding)
- [Applications, roster, and administration](#applications-roster-and-administration)
- [Saved administrator overrides](#saved-administrator-overrides)
- [Complete environment reference](#complete-environment-reference)
- [Deployment and troubleshooting](#deployment-and-troubleshooting)

## System overview

| Component | Responsibilities |
| --- | --- |
| ESO GuildSyncBanking | Collects cached guild gold-deposit history; classifies base tickets; sends receipt mail written into its queue. |
| ESO GuildSyncRoster | Collects roster/history events and optional current-member snapshots. |
| ESO GuildSyncApplications | Captures application decisions and prepares configured welcome actions. |
| GuildSync desktop app | Discord login, local SavedVariables watchers, reliable uploads, local backups, receipt queue writes, and operator screens. |
| GuildSync web app | Server-backed browsing and administration; does not access a user's local ESO SavedVariables. |
| Node.js backend / MariaDB | Authentication, durable records, account links, bonus policies, receipts, spreadsheet coordination, archive result persistence, and onboarding state. |
| Discord bot | Role/member synchronization, commands, application posts, optional raffle/archive announcements, and onboarding role/thread actions. |
| Google Sheets service account | Writes and rebuilds working/archive sheet data with configured protected-range access. |
| Google Apps Script | Uses the spreadsheet owner's Drive authority to find/create/verify archives, preserve sharing, read results, and complete archive metadata. |

Typical path: ESO collects in memory → ESO saves to disk → authenticated desktop watcher uploads → backend commits records → optional sheet export and subsequent command/receipt/report reads. Uploaded local records are cleared only after backend confirmation. If offline, records remain available for retry. Event IDs provide deduplication.

The database is the durable source for banking records. The working spreadsheet is a view of selected raffle data plus editable results; it is not a replacement for the database. A Discord command reads uploaded records, not the live ESO guild bank.

## Discord command reference

Use these in the configured Discord guild, not a DM. `option:value` is Discord slash-command option syntax. `/gsr` and `/gsraffle` have identical raffle subcommands. ESO uses a different `/gsr` command; see below.

All raffle/ticket summaries and automatic raffle posts retain the current `As of` timestamp and include a separate latest recorded transaction timestamp for each active raffle. The backend derives `latestTransactionAt` from the maximum transaction event time among the same raffle-type/sales-period entries used for its totals, excluding future entries. Selection remains on the closing raffle until draw time, then advances normally. This is a transaction date, not the upload time, message time, or proof that ingestion is current. Messages warn that GuildSync automation may lag behind actual deposit data. No entries yields an explicit empty-period message; an older backend without the field displays “unavailable.” No new configuration or database migration is required; update/restart both backend and bot.

| Command / options | Function | Access and visibility |
| --- | --- | --- |
| `/raffle` | Current Bi-Weekly and 50/50 summary: prize gold, ticket totals, draw/cutoff, current bonus and deadline. | Guild members subject to Discord command permissions; ephemeral by default. |
| `/raffle public:true` | Publishes the summary in the invocation channel. | Public. |
| `/raffle tickets:true` | Summary plus current purchases for caller's confirmed-linked ESO account. | Always ephemeral, including when `public:true`. |
| `/raffle verify:AccountName` | Current ticket lookup for the supplied name. Direct purchase account match is attempted before linked Discord username/display-name/nickname lookup. Rejects `@`, mentions, and URLs. Bot logs lookup input and result for diagnosis. | Exact case-sensitive Discord role **Consigliere**; ephemeral. |
| `/tickets` | Shortcut for own-ticket lookup without `tickets:true`. | Ephemeral. |
| `/tickets verify:AccountName` | Same officer verification as `/raffle verify`. | Exact **Consigliere**; ephemeral. |
| `/gsraffle load` or `/gsr load` | Rebuilds both current working raffle tabs from database records and saved result fields; sets draw dates and returns a working-file button. | Exact **Consigliere**, checked in bot and synced backend roles; ephemeral. |
| `/gsraffle load date:MMDDYY` or `/gsr load date:MMDDYY` | Selects the requested Bi-Weekly raffle and its containing 50/50 period. Uses the current working file only for the current selection when its draw dates match; otherwise finds or creates a historical archive and rebuilds that file. | Same officer access; ephemeral. |
| `/gsraffle update date:MMDDYY` or `/gsr update date:MMDDYY` | Reads supported editable result cells from an existing ready archive and replaces their saved database snapshot. Does not clear the sheet, import ticket purchase rows, reset live sheets, or create a missing archive. | Same access; date required; ephemeral. |
| `/gsraffle reset` or `/gsr reset` | Clears both working tabs' managed values and draw dates, retaining database entries. | Same access; ephemeral. |
| `/gsraffle archive` or `/gsr archive` | Archives current file, captures results, resets both working tabs, and reloads current records. Can finish an active delayed rollover immediately. | Same access; ephemeral result; separate configured channel notifications can also be sent. |
| `/roles` | Fetches roles/members from Discord, synchronizes backend records, and reports processed/removed counts. | Registered default **Manage Roles** permission. No extra runtime rank check. Ephemeral. |
| `/gsa post name:FullOrPartialName` | Reposts all saved application records matching the supplied ESO name to the application thread. | No built-in Consigliere/admin check; restrict in Discord Integrations if required. Private acknowledgement, application record posted to destination. |
| `/gsa stop` | Stops automatic application posting for this bot process. Manual reposts bypass this switch. | No built-in officer check; private acknowledgement. |
| `/gsa start` | Resumes automatic application posting. Bot starts enabled again after restart. | Same access. |

These are all currently registered production command names. There is no `/save`, `/gsr save`, standalone `/update`, bonus-settings slash command, or onboarding slash command. Retired test/`refresh`/`clear` command forms should not be used. Redeploying registers the current guild command list.

### Dates and boundary clarification

The canonical date is six zero-padded digits, **MMDDYY**, for a valid date in 2000–2099. Padded **MM/DD/YY** and **MM-DD-YY** input is translated automatically to MMDDYY. Unpadded separated dates or four/five-digit compact dates are accepted only when exactly one valid month/day interpretation exists; the bot shows the full date and normalized digits and requires **Confirm date** before any sheet/database mutation. Cancel or no answer within 60 seconds stops the operation. Ambiguous/impossible input fails with the required format; for example `11226` could be January 12 or November 2, so use `011226` or `110226`. The year must remain two digits. `092526` selects September 25, 2026. Explicit dates are evaluated at 7 p.m. **America/New_York**. At a Bi-Weekly transition, the bot asks whether the requested raffle **starts** or **ends** on that date. Only the initiating member can answer. The buttons expire after 60 seconds and timeout cancels without mutation. The chosen Bi-Weekly period determines the containing 50/50 period; there is no second independent question.

Both `load` and `update` use padding confirmation followed by any needed boundary clarification. Historical load shows the matching `update` command with the canonical, zero-padded lookup date. Use the same boundary answer when updating. Examples: `9/5/26` or `9526` offers `090526` for confirmation; `09/05/26` and `09-05-26` translate directly to `090526`. Backend mutation endpoints reject unconfirmed unpadded values and require the canonical value after confirmation. Omitting the date on `load` selects current periods without historical clarification. `update` always requires a date and a ready archive.

The internal type `monthly` means the **50/50** raffle. It closes on the last Bi-Weekly cutoff in the Eastern calendar month and can span four or six weeks; do not assume a fixed 28-day period. Bi-Weekly follows the existing 14-day schedule anchor. Draw time is one hour after sales cutoff. Summaries retain the closing raffle until the draw; purchase windows still close at cutoff. Selection/rebuild uses the existing schedule, not a new stored raffle-calendar table.

### Links and responses

Google document links in supported command results and archive announcements are converted to Discord URL buttons with labels such as **Open Working Raffle** and **Open Archived Raffle**. Discord controls the appearance of URL buttons; a bot cannot set arbitrary blue backgrounds, corner radius, or text colors on link buttons. The link grants no Google permission by itself.

Raffle commands return ephemeral results by default. Optional channel announcements are separate deliveries. Do not treat a private command result as proof that a channel notification has already been posted.

## ESO command reference

Install add-on folders in the ESO `live/AddOns` directory. Exported `.lua` data belongs in `live/SavedVariables`. GuildSyncBanking and GuildSyncRoster require **LibHistoire**; GuildSyncApplications requires **LibAddonMenu-2.0**. Add-on manifests currently declare version 1.2.7 and API 101050. Banking and roster target the guild name **Alphabet Mafia**, case-insensitively; that target is currently in Lua source, not a `.env` setting.

Commands are typed in **ESO chat**. Arguments are case-insensitive and trimmed. There are no additional registered slash aliases.

| Add-on | Command | Effect |
| --- | --- | --- |
| Banking | `/gsb`, `/gsb help` | Shows help. |
| Banking | `/gsb dump` | Prints matching cached gold deposits; does not save them or move progress. |
| Banking | `/gsb stream` | Starts/resumes collection after the saved event marker; starts at beginning if unset. |
| Banking | `/gsb stop` | Stops collection. |
| Banking | `/gsb reset` | Stops, clears progress, and restarts history collection; retains saved events and deduplicates IDs. |
| Banking | `/gsb status` | Shows running state and progress marker. |
| Banking | `/gsb debug on`, `/gsb debug off` | Persists verbose in-game output on/off. |
| Roster | `/gsr`, `/gsr help` | Shows roster help. This is not the Discord raffle command. |
| Roster | `/gsr dump` | Prints matching cached roster events without saving/moving progress. |
| Roster | `/gsr guildlist` | Captures a timestamped snapshot of current account names and rank names. |
| Roster | `/gsr stream` | Starts/resumes roster history collection. |
| Roster | `/gsr stop` | Stops collection. |
| Roster | `/gsr debug on`, `/gsr debug off` | Persists verbose roster output on/off. |
| Applications | `/gsa`, `/gsa help` | Shows application help; unrecognized arguments also show help. |
| Applications | `/gsa settings` | Opens welcome-message/email configuration in LibAddonMenu. |
| Applications | `/gsa list` | Prints captured application decisions and details. |

Banking/roster start automatically after their history library is ready. Banking captures **gold deposits**, not withdrawals, items, trader sales, or every kind of guild history. Roster tracks joins, leaves, kicks, promotions, demotions, and accepted/declined applications. There is no roster reset slash command.

The add-ons collect in memory. `/reloadui`, logout, or exit is the normal flush boundary before desktop upload. Stopping a stream does not disable the desktop file watcher, and disabling a file watcher does not stop ESO collection.

Saved files:

| Add-on | Export | Local collection state |
| --- | --- | --- |
| Banking | `GuildSyncBanking.lua` | `GuildSyncBankingState.lua` |
| Roster | `GuildSyncRoster.lua` | `GuildSyncRosterState.lua` |
| Applications | `GuildSyncApplications.lua` | Application settings/records in its SavedVariables |

Desktop watchers monitor the three export files, not the two stream-state files. Profile switches persist in the OS configuration directory under `GuildSync/file-watch-settings.json`; all three watchers default enabled. Authenticated sessions start watchers and logout stops them. Before export cleanup or mail-queue writes, backups go to `SavedVariables/GuildSyncBackups/<addon>/<filename>.backup-<timestamp>`.

## Banking, spreadsheets, archives, and updates

### Deposits and live export

Banking base-ticket classification uses deposit markers: Bi-Weekly `(gold − 1) / 500`, 50/50 `(gold − 3) / 2500`, requiring the respective integer-compatible marker. Examples: 501/1001 gold = 1/2 Bi-Weekly tickets; 2503/5003 = 1/2 50/50 tickets. Other deposits have no raffle tickets. The backend calculates dates/bonuses; the add-on calculates base tickets.

The backend commits banking records before attempting optional Google export. Export failure does not discard that deposit. It reads **Bi-Weekly R7** and **50/50 P7** to identify the periods currently displayed and compares each incoming record's type/timestamp. Records outside the displayed period, or with no valid draw date, remain in the database without live insertion. A future load/rollover can populate them. Live exports deduplicate by transaction ID, use the next available managed row, and do capacity checks rather than overwriting unrelated rows.

Both managed ticket areas are D5:F254. G contains preserved formulas; H stores bonus values/notes, with G/H shown when needed. Other deposit areas are P62:R70 on Bi-Weekly and N36:P44 on 50/50. Backend export coordinates local work plus a MariaDB advisory lock keyed to the source file, so concurrent operations cannot clear/append independently.

### Current load and reset

`load` rebuilds selected banking data from the database with duplicate suppression, selected draw dates, updater attribution, saved result values, and formula templates. It filters records by selected period and current export time. Clearing/rebuilding the two tabs is batched after validation/capacity checks. Empty periods still get their dates and clean managed fields.

Managed clearing includes ticket values, H bonus values/notes, donation areas, updater cells (R3:R4 or P3:P4), and configured result areas. `reset` additionally empties R7/P7. G formulas survive. Bi-Weekly J5:K254 values and managed formatting such as fills/text/alignment are cleared while **borders are preserved**. 50/50 J5:K254 is not cleared by that attendance-specific rule. Other layout/protections are retained.

`reset` does not delete records, archive, or prevent later live writes. Run `load` afterward to restore working dates/data before archiving. An archive needs valid dates; it does not invent today's date when R7 is blank.

### Archive and optional automatic rollover

The archive is a copy of the entire workbook, named from the Bi-Weekly draw date as **YYMMDD Raffle**. October 10, 2026 becomes `261010 Raffle`. Date-only interpretation preserves the spreadsheet calendar date, using Eastern schedule rules rather than trusting an empty spreadsheet timezone. R7 is required. P7 must identify a valid 50/50 date when nonempty 50/50 result fields are being captured; an invalid/blank P7 with no such fields can be omitted from the snapshot. Keep both working draw dates valid for normal live export.

Archive flow:

1. Lock the operation and persist recovery state.
2. Ask the configured Apps Script to copy the working file to its archive folder, preserve/check sharing, and verify the operation marker and dates.
3. Read supported nonempty result/diagnostic fields from the verified archive and commit them to the database before reset.
4. Replace older same-name archives only through the archive operation's verification/recovery flow. Replaced IDs are returned and saved references updated.
5. Atomically clear both working tabs with completion markers and set current draw dates.
6. Replay current database purchases, including the ongoing 50/50 period and held deposits.
7. Record completion and make the private result/optional channel announcement available.

Failures keep reset/replay paused and retry the persisted operation. A retry reuses its operation identity; it is not a request to make another archive. Another command after completion is a new snapshot. Replacing an older file moves it to Trash, creates a new archive ID, and updates database references to that ID. Old external links do not redirect. The working file ID remains unchanged.

Automatic rollover is separately opt-in. On first enablement it arms upcoming cutoffs, rather than guessing what an old sheet represents. At sales cutoff, sheet writes to both tabs pause while database uploads continue. After the configured delay, normally four hours from **sales cutoff**, the same archive/reset/replay flow runs. The scheduler checks roughly each minute. A manual archive can bypass the hold and complete it sooner. Current load/reset are blocked while the live rollover hold requires completion. Keep the source ID, tab names, Apps Script project, and saved recovery state stable during an unfinished operation.

### Historical load preserves the live file

For an explicit historical date, GuildSync determines the Bi-Weekly ending date, derives its `YYMMDD Raffle` filename, and searches **inside the configured archive folder**. The registry records archive IDs, but the current resolver always searches by filename in that folder, then verifies the selected file's identity/dates. A stale registered ID does not override the name search. Ambiguous matches are reported rather than choosing an arbitrary file.

If an archive exists, GuildSync reuses that file ID. It captures supported edits from a ready existing archive before rebuilding its managed fields from database records/results. If no archive exists, Apps Script copies the configured **working source** into the archive folder, assigns the requested dates, and marks it preparing. Copied current winner values are cleared before historical data is populated; they are not saved as results for the old raffle. After population succeeds, it marks the new file ready and captures the populated result fields. The original working file is not rewritten for this historical load.

The result gives an archive button and the exact `update date:…` instruction. File lookup diagnostics in bot logs include expected filename, search matches, folder, selected ID, and whether a file was created. Update logs identify the file name/ID being read. Loading/updating an existing historical archive does not normally replace that file or change its ID.

### Result persistence and update

`update` reads the supported result fields from the selected **ready archive**. It does not read the current working sheet instead, create a missing archive, clear the file, or import edited ticket purchase rows. If missing/incomplete, use matching `load` first. Empty cells clear previously saved entries for that raffle; changes replace saved values rather than appending duplicates.

| Persistence | Fields / identity |
| --- | --- |
| `guildsync_raffle_archive_cells` | Sparse nonempty displayed values at Bi-Weekly Q33:Q52, J5:K254, O55; 50/50 P25 and M28. Stores archive ID, raffle type, draw date, source ID, tab, cell address/value, capture time. Primary key `(archive_id, raffle_type, cell_address)`. Existing cells for source/type/draw date are cleared transactionally before replacement. |
| `guildsync_raffle_results` | Snapshot per raffle type and period start/end, with archive/source IDs and typed cells JSON. General result layout also includes Bi-Weekly S31:S50 and 50/50 L23/J26. Completed-result and snapshot pathways differ; do not assume every field is captured by every command. |
| `guildsync_raffle_result_formulas` | Formula templates retained for managed result ranges and subsequent rebuilding. |
| `guildsync_settings` | Historical archive registry (`raffle_archive_*`), rollover holds/recovery (`sheets_rollover_*`), completion history, and other settings. |

The current historical `load`/`update` path restores the sparse archive-cell set listed in the first row. Attendance bonus values in K are restored numerically where valid. General result snapshot code retains captured values/formulas with separate template preservation; historical values are restored as captured literals, not recalculated winners. Backend startup creates required tables idempotently. Existing archives are not all scanned/backfilled at startup.

Source ID scopes the configured installation; it is not sufficient to identify one historical raffle because the source is reused. Archive ID plus raffle identity locate saved records. When archive replacement reports old IDs, old archive cells are removed, result/registry references are updated to the new ID, and fresh current snapshots replace obsolete cells. Always preserve the database during deployment.

Temporary archive diagnostics echo nonempty captured Q/J/K/O/P/M fields in the Sheets log. Routine per-row read/write dumps were reduced; batch summaries and failure/recovery details remain. There is no `.env` verbose-row toggle currently.

See the [Apps Script setup and account migration guide](google-apps-script-setup.md) for exact Google configuration steps.

## Raffle bonus tickets and receipts

Bonus settings live in **Reports & Admin → Raffle Bonus Settings** in GuildSync. Editing requires GuildSync application role **admin**, which is distinct from the Discord **Consigliere** role. Settings are separately enabled for Bi-Weekly and 50/50. Choose defaults for future behavior or a specific raffle for an override, including a past raffle. Changes apply only when saved. An enabled raffle is labeled **(Bonuses)**; disabling removes that label.

Tier syntax is sequential `hours:percent` blocks, 1–12 blocks, positive whole hours, percentage 0–100, nonincreasing percentages, final tier 0%. Default schedule duration is capped at 336 hours for Bi-Weekly and 672 hours for 50/50. Individual raffle overrides validate tier syntax and require existing purchases, but do not enforce that duration cap. Tiers are aligned to sales end; the configured durations work backward from that cutoff. Default Bi-Weekly: `120:20,120:10,72:5,24:0`. Default 50/50: `168:40,168:20,168:10,144:5,24:0`. Those schedules end with 24 hours of 0% bonus. Do not use a fixed weekly schedule for 50/50.

The calculation is `floor(base tickets × bonus percent / 100)` per purchase; total tickets = purchased + bonus. Manual ticket entries never receive an additional calculated bonus. Bonus does not increase deposited gold/prize pools. Saved policy versions apply across an open raffle; completed policy selection is frozen at sales end. Per-raffle overrides take precedence and can intentionally revise historical calculations. `.env` bonus values are bootstrap defaults only once saved database settings exist.

Prize summaries remove marker gold. Bi-Weekly uses half of eligible deposits rounded up to whole 200,000-gold draws; 50/50 uses half rounded down to whole gold. These are prize totals, not total deposited gold.

### ESO receipt mail

Receipts show the actual deposit/ticket cost, including its +1/+3 marker. When bonus percentage is positive, the backend adds the early purchase percentage and deadline, bonus tickets, and total tickets. At 0%, the bonus block is empty and not appended. A positive percentage can legitimately produce 0 bonus tickets for a small purchase because of rounding.

1. An authorized desktop operator checks out unsent receipt mail from the backend.
2. The desktop persists pending batches and waits until **ESO is fully closed** before writing its SavedVariables mail queue. `/reloadui` alone does not satisfy that safety check.
3. It backs up the file, preserves other banking data, writes distinct request IDs, verifies them, and records queue-written status with the backend.
4. On next add-on load, Banking processes the queue, waits one second, then invokes ESO `SendMail` at two-second spacing.
5. It records request IDs/acknowledgements, skips already-sent IDs, and removes processed queued entries.
6. ESO saves those acknowledgements to disk; the desktop uploads them and later cleans acknowledged records safely.

The add-on's `sent` acknowledgement means **the SendMail call was issued**, not that ESO confirmed server delivery. There is no `/gsb mail` or receipt-resend slash command. The browser app cannot write local queues.

Receipt templates are optional backend settings. `{bonus_block}` is the conditional section; an existing template without that placeholder has the positive-bonus block appended automatically. If customizing a template, use `{bonus_block}` to avoid an unconditional 0% section. Available placeholders:

| Group | Placeholders |
| --- | --- |
| Recipient/type | `{recipient}`, `{account_name}`, `{display_name}`, `{ticket_type}`, `{ticket_type_raw}`, `{transaction_type}` |
| Deposit/cost | `{amount}`, `{deposit_amount}`, `{ticket_gold_cost}`, `{gold_cost}`, `{raw_amount}`, `{raw_deposit_amount}`, `{raw_ticket_gold_cost}`, `{raw_gold_cost}` |
| Tickets/bonus | `{ticket_quantity}`, `{tickets}`, `{purchased_tickets}`, `{bonus_percent}`, `{bonus_tickets}`, `{total_tickets}`, `{bonus_deadline}`, `{bonus_block}` |
| Dates | `{purchase_date}`, `{raffle_datetime_eastern}`, `{raffle_date_time_eastern}`, `{raffle_datetime}`, `{event_datetime}`, `{event_timestamp}` |
| Context | `{event_id}`, `{data_source}`, `{note}`, `{note_block}`, `{mail_request_id}`, `{mail_batch_id}` |

## Discord links and onboarding

Role synchronization discovers every Discord role except `@everyone`, including newly created **Gangsters**. Existing rank comparison uses plural Discord **Associates/Soldiers**, while ESO rank names use singular **Associate/Soldier**. Onboarding name lookup follows the plural convention: unique case-insensitive **Gangsters** and **Associates**, or explicit stable role IDs. It does not rename Discord roles. A server using other names must configure IDs. **Consigliere** command authorization remains exact and is not pluralized.

Automatic confirmed exact account matches, manual links, and accepted link candidates qualify. Unaccepted fuzzy candidates do not. Manual unlink/block prevents automatic relinking until unblocked. Staff can review candidates and create/remove links in the Member Links tools. A matching nickname alone is not a confirmed database link until matching has run.

When enabled, a confirmed-linked Gangsters member gets Associates added first, then Gangsters removed. Other roles remain. Both roles must be manageable below the bot's highest role. Full access comes from your Associates permissions; GuildSync does not rewrite permissions or promote the ESO rank. The existing **Associates Promotion Eligible** report is a separate ESO advancement aid, not this Discord access automation.

### Notifications and reminders

Default mode is `private_thread`: a bot-owned, member-specific `guildsync-<Discord ID>` thread under the configured normal text channel. Private threads are non-invitable and add the intended member. The parent must be visible to Gangsters and Associates. Private-thread moderators/administrators can still view them. If private creation permission is unavailable or Discord rejects creation for access/permission reasons, GuildSync creates a **public thread under that same configured parent**. This is the requested fallback and is visible to members with parent access. It logs the fallback and reuses its thread ID. A network/history failure does not trigger public creation. There is no DM fallback or unrelated-channel fallback.

Give the bot View Channel, Read Message History, Send Messages in Threads, and Create Private Threads; also Create Public Threads for fallback. Manage Threads is recommended for full private archive discovery and moderation. Without it, recovery enumerates only joined private threads. If neither creation mode is permitted, delivery retries after configuration is fixed. `channel` mode instead posts directly to the specified channel or existing thread with corresponding send permission. This mode does not create a member thread.

Promotion notifications occur after successful role changes. They include the confirmed ESO name and a member ping. The reminder applies only to non-bot members with actual join timestamp **after** reminders became active. After the configured delay, normally 24 hours, still-unlinked members get one reminder. Existing members are excluded on enablement. Completed reminders survive restarts and leave/rejoin and are not repeated. A returning Gangsters member can be promoted again with a distinct promotion delivery identity.

Backend registration establishes the cutoff, not editing `.env`. Restarts retain it; disabling and re-enabling establishes a new cutoff, excluding members who joined while disabled. Reconnection snapshots use true join timestamps to recover missed events. Link/leave cancels pending reminders; fresh membership is rechecked before side effects. Promotion is independent of new-join reminder enrollment and can apply to older linked Gangsters members.

Separate master/promotion/promotion-notification/reminder switches allow silent promotions or reminders without promotions. Templates support `{mention}`, `{eso_name}`, `{associate_role}`, `{hours}`. Blank uses defaults; unknown placeholders or templates over 1800 characters are rejected. Fixed account-linking headings and a target mention are retained even if a custom template omits `{mention}`. Only that user's mention is allowed; inserted account names are escaped. User notification preferences can suppress push alerts.

Persistent tables are `guildsync_discord_onboarding_state` (configuration/cutoff), `guildsync_discord_onboarding_members` (enrollment/thread/completion), and `guildsync_discord_onboarding_deliveries` (jobs/generations/leases/content/message IDs). Startup creates them. Guild row locks serialize claims; worker polls roughly each minute. Claims last five minutes; errors retry after about one minute. Progress is saved before role/delivery steps. Uncertain message sends reconcile recorded destination, heading, recipient, content, nonce when present, and earlier completed IDs before resending. Preserve these tables and use one bot configuration per guild; deletion can defeat the one-time rule. Do not change destinations during an uncertain send; restore the old destination to reconcile it first.

See [member onboarding setup](../NodeJS/GuildSync-Discord-Bot/MEMBER-ONBOARDING.md) for ready-to-edit settings and permissions.

## Applications, roster, and administration

GuildSyncApplications hooks the local application decision API; it is not an auto-approval service or a full historical retriever. Accept actions are confirmed against membership after two seconds; failed confirmation removes the record and skips welcome actions. Backend application ingestion is restricted to `GUILDSYNC_APPLICATIONS_GUILD_ID`.

`/gsa settings` in ESO manages enabled welcome chat/mail templates. Save edits explicitly. `{name}` inserts the applicant account. Chat messages allow up to 335 characters. Valid enabled custom entries are selected with weighting toward less-used/less-recent entries; built-in defaults serve when no valid custom entries remain. Configured welcome email is sent automatically after confirmed acceptance, including decisions in other guilds; the default text welcomes applicants to Alphabet Mafia. Officer-chat preparation specifically targets Alphabet Mafia. For an online applicant, welcome chat is populated in **officer chat** with an alert, and the officer presses Enter. Chat is not automatically broadcast. ESO permissions govern decisions/officer chat; the Lua add-on has no separate officer-role gate.

Discord application posting requires a configured existing thread. Its `/gsa start/stop` switch is process-local, not a saved `.env` flag. Restrict those commands via Discord Integrations if appropriate.

Desktop/web screens provide member/roster history, notes, account-link review, bank deposits, ticket allocations/manual entries, section reclassification, and reports according to application access. **Associates Promotion Eligible** checks the ESO Associate rank, at least two weeks membership, a raffle ticket, and a Discord link, and also identifies otherwise-qualified accounts needing link review. **Discord Rank Audit** compares linked ESO/Discord ranks; **Discord Last Seen** uses recorded activity. The bot can run a bounded startup historical activity scan to seed that data when no valid completion exists or the last completion is at least seven days old; it does not promise complete lifetime Discord history.

## Complete environment reference

Use each component's own `.env`/deployment environment. Restart the owning process after changes. **Required** means the component cannot perform the stated function without a valid value; **optional** means a built-in default exists; **conditional** means needed only when the feature is enabled. Defaults below are runtime defaults, not necessarily the example file's chosen value. Keep tokens, JSON credentials, database passwords, and shared secrets private. Examples contain placeholders, not production credentials.

### Backend: core, login, and database

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `HOST` | Optional; `127.0.0.1` | HTTP/socket bind address. Example uses `0.0.0.0` for network/proxy access. |
| `PORT` | Optional; `3001` | Backend HTTP/socket port. |
| `DISCORD_CLIENT_ID` | Required | Discord OAuth application ID. |
| `DISCORD_CLIENT_SECRET` | Required; secret | Server-side OAuth client secret; never place in desktop settings. |
| `DISCORD_REDIRECT_URI` | Optional; `http://127.0.0.1:53682/callback` | Desktop OAuth local callback; must match Discord application configuration. |
| `DISCORD_WEB_REDIRECT_URI` | Optional; `https://guildsync.perdues.me/api/auth/discord/web-callback` | Browser OAuth callback; configure for your public origin and Discord app. |
| `GUILDSYNC_WEB_PUBLIC_URL` | Optional; `https://guildsync.perdues.me` | Public web origin/download-link base; change for another deployment. |
| `GUILDSYNC_JWT_SECRET` | Required; secret | Session token signing secret. |
| `GUILDSYNC_TOKEN_TTL_SECONDS` | Present in example but currently unused | Does not set session lifetime; current JWT signing does not apply this value. Do not rely on it for expiry. |
| `GUILDSYNC_BOT_SOCKET_KEY` | Required; secret | Bot authentication shared key; match bot `GUILDSYNC_BOT_KEY`. |
| `GUILDSYNC_CLIENT_VERSION` | Required; current example `1.2.7` | Release version offered to clients; matching installer files must exist. |
| `GUILDSYNC_WEB_DIST_DIR` | Optional; backend `public` | Served web bundle directory. |
| `GUILDSYNC_DOWNLOADS_DIR` | Optional; backend `public/downloads` | Installer ZIP directory. |
| `MARIADB_HOST` | Optional; `127.0.0.1` | Database host. |
| `MARIADB_PORT` | Optional; `3306` | Database port. |
| `MARIADB_USER` | Required | Database account; allow startup schema initialization. |
| `MARIADB_PASSWORD` | Required; secret | Database account password. |
| `MARIADB_DATABASE` | Optional; `guildsync` | Application database name. |
| `MARIADB_CONNECTION_LIMIT` | Optional; `10` | Connection pool size. |
| `GUILDSYNC_APPLICATIONS_GUILD_ID` | Optional; `761817` | ESO guild ID accepted for application records. Distinct from Discord guild ID. |
| `DATA_DIR` | Old commented example; unused | Database storage is managed by MariaDB, not this variable. |

Core login requires an allowed GuildSync user record. The application's admin role and Discord rank are different permission systems. Sessions are recorded in `guildsync_login_sessions`; this table supports validity/revocation independently of the unused TTL example.

### Backend: Google Sheets and archives

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `GUILDSYNC_GOOGLE_SHEETS_ENABLED` | Optional; `false` | Enables spreadsheet export/administration. Banking database ingestion remains available when disabled. |
| `GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID` | Conditional | Stable working workbook ID, not a tab `gid` or archive ID. |
| `GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_FILE` | Conditional; file or JSON needed | Backend-readable service-account JSON path. |
| `GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON` | Conditional alternative; secret | Complete inline JSON; takes precedence over file if set. Clear stale inline JSON when switching to a file. |
| `GUILDSYNC_GOOGLE_SHEETS_BIWEEKLY_TAB` | Optional; `bi-weekly raffle` | Exact Bi-Weekly tab title; set to your workbook's spelling/case. |
| `GUILDSYNC_GOOGLE_SHEETS_5050_TAB` | Optional; `50/50` | Exact 50/50 tab title. |
| `GUILDSYNC_GOOGLE_SHEETS_LOG_FILE` | Optional; backend `logs/google-sheets.log` | Sheets operation/diagnostic log path; relative paths resolve from backend directory. Requires write access. |
| `GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED` | Optional; `false` | Automatic delayed archive/reset; independent of ordinary export/manual archive. |
| `GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS` | Optional; `4` | Delay from cutoff; nonnegative hours resolving to whole seconds. Saved hold deadlines do not change mid-hold. |
| `GUILDSYNC_GOOGLE_ARCHIVE_WEB_APP_URL` | Conditional for archive/historical load/update | Existing Apps Script deployment URL ending `/exec`, not `/dev`. |
| `GUILDSYNC_GOOGLE_ARCHIVE_SECRET` | Conditional; secret | Must match Apps Script `ARCHIVE_SECRET`. |

Share working/created files with the service account as Editor, including protected managed cells. Apps Script runs as the owner, uses the advanced Drive v3 service, and needs Script Properties **`SOURCE_SPREADSHEET_ID`**, **`ARCHIVE_FOLDER_ID`**, **`ARCHIVE_SECRET`**. These are Script Properties, not `.env` variables. Owner deployment must be callable by the backend without browser sign-in. Folder permissions affect archive access.

Obsolete backend settings no longer read: `GUILDSYNC_GOOGLE_OAUTH_CLIENT_ID`, `GUILDSYNC_GOOGLE_OAUTH_CLIENT_SECRET`, `GUILDSYNC_GOOGLE_OAUTH_REFRESH_TOKEN`, `GUILDSYNC_GOOGLE_SHEETS_ARCHIVE_FOLDER_ID`. Folder ID belongs in Script Properties. `GUILDSYNC_RAFFLE_TEST_COMMANDS_ENABLED` is retired in both backend and bot.

### Backend: bonus defaults and receipt templates

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `GUILDSYNC_RAFFLE_BONUS_ENABLED` | Optional; `true` | Initial default bonus enablement; database settings/individual overrides govern after saving. |
| `GUILDSYNC_BIWEEKLY_BONUS_TIERS` | Optional; `120:20,120:10,72:5,24:0` | Initial Bi-Weekly schedule. |
| `GUILDSYNC_MONTHLY_BONUS_TIERS` | Optional; `168:40,168:20,168:10,144:5,24:0` | Initial 50/50 schedule (`monthly` internal name). |
| `GUILDSYNC_DEPOSIT_MAIL_FORCE_RECIPIENT` | Optional; blank | Testing override sends all checked-out receipts to one account; leave blank for normal recipients. |
| `GUILDSYNC_DEPOSIT_MAIL_SUBJECT_TEMPLATE` | Optional; built-in raffle receipt subject | Receipt subject template. |
| `GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE` | Optional; built-in thank-you/receipt body | Receipt body template; use conditional `{bonus_block}` for bonus details. |

See the placeholder table above. Node dotenv double-quoted templates can contain escaped `\n` for line breaks. Unknown receipt placeholders remain literal, whereas onboarding template placeholders are validated. There is no receipt delivery toggle in these variables; queue checkout/delivery is an operator workflow.

### Discord bot: connection, commands, and applications

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required; secret | Bot login token; also used to register commands. |
| `DISCORD_CLIENT_ID` | Required for command deployment | Discord application ID used by `npm run deploy`. |
| `DISCORD_GUILD_ID` | Required for guild command deployment/announcements/onboarding | Server to synchronize and scope features. Set explicitly; distinct from ESO guild ID. |
| `GUILDSYNC_SOCKET_URL` | Required | Backend HTTP(S)/Socket.IO origin. |
| `GUILDSYNC_BOT_KEY` | Required; secret | Must match backend `GUILDSYNC_BOT_SOCKET_KEY`. |
| `GUILDSYNC_HISTORICAL_SCAN_ON_STARTUP` | Optional; disabled if unset (example `true`) | Enables a bounded startup activity scan when no valid completion exists or last completion is at least seven days old; not a periodic timer. |
| `GUILDSYNC_HISTORICAL_SCAN_MESSAGE_LIMIT_PER_CHANNEL` | Optional; `1000` | Upper bound of historical messages checked per text/announcement channel. |
| `ESO_GUILD_APPLICATIONS` | Conditional for application posting | `DiscordGuildID:ExistingThreadID`; destination must be a thread. |

Enable the Discord privileged **Server Members Intent** for membership synchronization. Give destination permissions appropriate to each optional feature. `/roles` and the bot's startup/live events keep role records current; adding Gangsters needs no whitelist modification.

### Discord bot: optional raffle announcements

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `GUILDSYNC_RAFFLE_CHANNEL_ID` | Optional; blank disables | Channel for regular, milestone, and deadline raffle announcements; does not disable `/raffle`. |
| `GUILDSYNC_RAFFLE_INTERVAL_HOURS` | Optional; `48` | Regular summary interval after a successful combined post. |
| `GUILDSYNC_RAFFLE_BONUS_REMINDER_HOURS` | Optional; `1` | Positive lead hours before bonus tier changes/expiration; comma-separated values allow several reminders. |
| `GUILDSYNC_RAFFLE_SALES_CLOSE_REMINDER_HOURS` | Optional; `2` | Positive lead hours before sales cutoff; comma-separated values supported. |
| `GUILDSYNC_RAFFLE_BIWEEKLY_THRESHOLD` | Optional; `200000` | Prize-gold milestone increment for an early combined summary. |
| `GUILDSYNC_RAFFLE_MONTHLY_THRESHOLD` | Optional; `500000` | 50/50 prize-gold milestone increment. |
| `GUILDSYNC_RAFFLE_STATE_FILE` | Optional; bot `data/raffle-announcements.json` | Persistent delivery/milestone state; retain across deployment. |
| `GUILDSYNC_RAFFLE_ARCHIVE_CHANNEL_IDS` | Optional; blank disables | One or comma-separated channel IDs for completed archive notifications. No fallback to ordinary raffle channel. |
| `GUILDSYNC_RAFFLE_ARCHIVE_STATE_FILE` | Optional; bot `data/raffle-archive-announcements.json` | Persistent per-archive/per-channel delivery state. |

Regular announcements check about every five minutes and on reconnect. They combine both raffle types; new periods and prize milestones can cause early posts. Deadline reminders are approximate and are not sent after their deadline. Archive completion announcements check about every minute and are available only after successful archive/reset/replay. Adding a destination later can send retained completed events not yet delivered there.

Each destination needs View Channel, Send Messages, and Read Message History in the configured guild. Keep state on writable persistent storage and run one announcing bot instance per state file. Interrupted posts reconcile bot-authored history; unreadable history stops a blind resend. Disabling announcements retains backend history. Deleting state or messages can permit reposts.

### Discord bot: optional onboarding

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `GUILDSYNC_ONBOARDING_ENABLED` | Optional; `false` | Master switch for promotions/reminders. |
| `GUILDSYNC_ONBOARDING_PROMOTION_ENABLED` | Optional; `true` | Promote confirmed-linked Gangsters to Associates when master enabled. |
| `GUILDSYNC_ONBOARDING_PROMOTION_NOTIFY_ENABLED` | Optional; `true` | Message after successful promotion; false permits silent role changes. |
| `GUILDSYNC_ONBOARDING_REMINDER_ENABLED` | Optional; `true` | Enroll new members and send one unlinked reminder. |
| `GUILDSYNC_ONBOARDING_REMINDER_HOURS` | Optional; `24` | Positive delay up to 8760 hours. |
| `GUILDSYNC_ONBOARDING_NOTIFICATION_MODE` | Optional; `private_thread` | Private-first per-member thread, with public-thread fallback under same channel, or direct `channel` delivery. |
| `GUILDSYNC_ONBOARDING_CHANNEL_ID` | Conditional for enabled notifications | Normal text parent in private-thread mode; existing channel/thread in channel mode. Not needed for silent promotion-only setup. |
| `GUILDSYNC_ONBOARDING_GANGSTER_ROLE_ID` | Optional; blank | Stable role ID; otherwise resolves unique case-insensitive **Gangsters**. |
| `GUILDSYNC_ONBOARDING_ASSOCIATE_ROLE_ID` | Optional; blank | Stable role ID; otherwise resolves unique case-insensitive **Associates**. |
| `GUILDSYNC_ONBOARDING_PROMOTION_MESSAGE` | Optional; blank uses built-in | Editable account-linked/promotion template. |
| `GUILDSYNC_ONBOARDING_REMINDER_MESSAGE` | Optional; blank uses built-in | Editable unlinked/name-matching reminder template. |

Onboarding booleans must be `true` or `false`; IDs must be numeric. Invalid settings stop this worker and log the reason without stopping unrelated bot features. Use the [onboarding guide](../NodeJS/GuildSync-Discord-Bot/MEMBER-ONBOARDING.md) to configure templates and permissions. Restart bot after edits. No slash registration is needed just to change onboarding settings.

### Desktop: optional local overrides

Desktop files load in order: executable-directory `.env`, executable-directory `GuildSyncSettings.txt`, working-directory `.env`, working-directory `GuildSyncSettings.txt`; later file values win, and real OS environment variables take priority over file values. An optional legacy client config file can override connection defaults/environment. Do not put backend secrets into these files.

| Setting | Status / default | Purpose |
| --- | --- | --- |
| `SAVED_VARS_DIR` | Optional; user `Documents/Elder Scrolls Online/live/SavedVariables` | SavedVariables directory; useful for moved Documents folders, macOS, or Proton paths. |
| `SAVED_VARS_BANKING_FILE_NAME` | Optional; `GuildSyncBanking.lua` | Banking export filename. |
| `SAVED_VARS_ROSTER_FILE_NAME` | Optional; `GuildSyncRoster.lua` | Roster export filename. |
| `SAVED_VARS_APPLICATIONS_FILE_NAME` | Optional; `GuildSyncApplications.lua` | Application export filename. |
| `SAVED_VARS_BANKING_TABLE_NAME` | Optional; `GuildSyncBanking` | Top-level banking Lua table name for parsing. |
| `SAVED_VARS_ROSTER_TABLE_NAME` | Optional; `GuildSyncRoster` | Top-level roster Lua table name for parsing. |
| `SAVED_VARS_APPLICATIONS_TABLE_NAME` | Optional; `GuildSyncApplications` | Top-level application Lua table name for parsing. |
| `GUILDSYNC_DISCORD_CLIENT_ID` | Optional; packaged default | Desktop OAuth application ID override. |
| `GUILDSYNC_DISCORD_REDIRECT_URI` | Optional; `http://127.0.0.1:53682/callback` | Local desktop OAuth listener/redirect. |
| `GUILDSYNC_AUTH_SERVER_URL` | Optional; packaged deployment URL | Backend authentication origin. |
| `GUILDSYNC_SOCKET_URL` | Optional; packaged deployment URL | Backend Socket.IO origin. |

The profile's three watcher switches are saved application preferences, not `.env` flags. In-game debug settings and welcome templates are ESO SavedVariables settings, also not server `.env` flags.

## Deployment and troubleshooting

### Deploying safely

1. Merge approved PRs, deploy matching backend/bot source, and preserve MariaDB and announcement state files. Finish existing archive recovery before changing source/project identity.
2. Install locked Node dependencies with `npm ci` in each Node component when dependencies change. Start with the existing service manager or `npm start` in the respective directory.
3. After slash command definitions change, run `npm run deploy` in `NodeJS/GuildSync-Discord-Bot`. This replaces that application's registered command list in `DISCORD_GUILD_ID`; it is a deployment action, not automatic during development.
4. For web source updates, use backend `npm run build:web` and deploy the resulting served bundle. Desktop source changes require the desktop build/package workflow; see [release instructions](GuildSync-1.2.7.md).
5. If `Archive.gs` changes, paste the current source into the **existing** Apps Script project, save, and deploy a **new version** through Manage deployments while retaining URL/properties. This documentation/onboarding change does **not** modify Apps Script.
6. Verify a test spreadsheet/server before live archive/reset, since those commands copy and clear managed data. Backend startup handles the existing table creation/migrations; standalone raffle-result SQL is available under backend `migrations` for separately managed deployments.

### Common issues

| Symptom | Check / response |
| --- | --- |
| Discord command missing or old `/save` shown | Deploy the current guild command list, correct app/guild ID, restart bot. |
| Consigliere denied | Exact role spelling/case and synced backend role records. Use `/roles` with suitable permission or wait for synchronization. |
| Own tickets missing | Confirmed ESO link, uploaded deposits, selected raffle period, correct gold marker. Verification logs show input and returned data. |
| ESO data not appearing | Correct AddOns/dependencies, Alphabet Mafia membership/history access, collection state, `/reloadui`, SavedVariables path, authenticated desktop watcher and socket. |
| Receipt queue waiting | Close ESO completely, allow desktop retry/write, reopen ESO, then flush acknowledgements later. `sent` is a send-call acknowledgement. |
| Invalid JSON from archive web app | Correct `/exec` deployment, owner execution/backend access, matching secret/source ID, latest deployed version; backend surfaces script stage/errors. An uncertain response may occur after work succeeded, so inspect recovery/logs before retrying. |
| Empty/mismatched R7/P7 date | Restore correct current dates with `load`; do not fabricate an archive date. Verify selected schedule and configured tab names. |
| Historical file not found | Expected `YYMMDD Raffle`, configured archive folder, owner access, lookup logs. Historical `load` creates a missing file; `update` requires one already ready. |
| Sheet ID appears to change | Historical load/update should reuse an existing archive ID. Live archive replacement legitimately creates a new one. Inspect expected filename, folder, matches, created flag, and selected ID. |
| Writes paused | Pending cutoff hold or failed archive/reset/replay. Records remain in database; fix error and let persisted recovery complete. |
| Promotion not happening | Master/promotion switches, confirmed link rather than candidate, plural roles or configured IDs, role hierarchy/Manage Roles, bot/backend connection. |
| Onboarding notification missing | Configured parent visible to member, thread/send/history permissions, master/notification/reminder switches, join cutoff/delay, pending delivery `last_error`. |
| Public onboarding thread appears | Private creation was unavailable and requested fallback was used; inspect bot log and grant private permission to prefer private threads for future new destinations. Existing thread IDs are reused. |

Backend Sheets logs default to `NodeJS/GuildSync-Backend-Server/logs/google-sheets.log` and stdout. Bot stdout uses `[DISCORD BOT]`, including raffle lookup/verification and `Onboarding` messages. These can include account names, user IDs, cell values, and ticket information; apply ordinary private operational-log access. ESO `/gsb debug` and `/gsr debug` affect game chat output, not these server logs.

Current repository packaging note: the roster manifest names `GSRData.lua`, but that file is not present in the checked-in ESO folder. Check the installed roster payload if ESO reports a missing file; this documentation change does not silently alter the add-on manifest.

### Implementation pointers

| Topic | Source |
| --- | --- |
| Command registration/behavior | Bot [deploy-commands.js](../NodeJS/GuildSync-Discord-Bot/src/deploy-commands.js), [commands](../NodeJS/GuildSync-Discord-Bot/src/commands/gsa-raffle.js) |
| Spreadsheet export and locking | [google-sheets-banking-sync.js](../NodeJS/GuildSync-Backend-Server/google-sheets-banking-sync.js), [sheets-rollover-runtime.js](../NodeJS/GuildSync-Backend-Server/sheets-rollover-runtime.js) |
| Historical archive identity/update | [historical-raffles.js](../NodeJS/GuildSync-Backend-Server/historical-raffles.js), [Archive.gs](../scripts/google-apps-script/Archive.gs) |
| Sparse saved fields | [raffle-archive-cells.js](../NodeJS/GuildSync-Backend-Server/raffle-archive-cells.js), [raffle-results.js](../NodeJS/GuildSync-Backend-Server/raffle-results.js) |
| Bonus calculation | [raffle-bonus.js](../NodeJS/GuildSync-Backend-Server/raffle-bonus.js) |
| Onboarding worker/store | [member-onboarding.js](../NodeJS/GuildSync-Discord-Bot/src/member-onboarding.js), [discord-onboarding.js](../NodeJS/GuildSync-Backend-Server/discord-onboarding.js) |
| ESO add-ons | [Banking](../ESO/GuildSyncBanking/GuildSyncBanking.lua), [Roster](../ESO/GuildSyncRoster/GuildSyncRoster.lua), [Applications](../ESO/GuildSyncApplications/GuildSyncApplications.lua) |

External protocol references: [Discord threads](https://github.com/discord/discord-api-docs/blob/main/developers/topics/threads.mdx), [Discord permissions](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx), and [Apps Script deployment setup](google-apps-script-setup.md). Repository behavior is defined by the source files above.


## Saved administrator overrides

Both desktop and web **Reports & Admin** provide collapsible bonus and administrator configuration sections. Approved GuildSync users (`allowed = 1`) can view Administrator Configuration and inspect raffle bonus policies. Only users whose current login database role is `admin` can save either section. Administrator Configuration read requests check current approval; save requests recheck administrator access. Discord Consigliere access does not grant GuildSync administrator rights.

See [Administrator Configuration](GuildSync-Admin-Configuration.md) for the complete override catalog, defaults, validation, live refresh behavior, and database inspection query. Overrides are stored in the existing startup-created `guildsync_settings` table under `admin_configuration`; no manual migration is required. Bonus settings retain their separate policy/version/raffle override tables. Changing `.env` itself still requires restarting its owning process; removing an override restores that process's original environment default.

The additional optional bot switches `GUILDSYNC_RAFFLE_ANNOUNCEMENTS_ENABLED` and `GUILDSYNC_RAFFLE_ARCHIVE_ANNOUNCEMENTS_ENABLED` default to `true`. A destination must still be configured, so existing deployments remain opt-in. Set either to `false`, or save a disabled override in GuildSync, to pause that notification system without removing its destination. Existing delivery records are retained.


### Higher-rank onboarding and default labels

Confirmed-linked Gangsters who already hold a higher guild rank (Soldiers, Capo, Caporegime, Consigliere, Kingpin, or recognized singular/plural naming variants) keep that rank and lose only Gangsters. Existing Associates is preserved; Associates is not newly granted and no Associate-promotion notification is sent. Cleanup is logged and safely retried if Discord's removal acknowledgement is uncertain. Non-rank/decorative roles do not block a normal Associate promotion.

Administrator Configuration uses **Return to default** and shows the default alongside the current selection. Switches consistently display **Enabled/Disabled**, while saved boolean data remains true/false internally. Resetting still deletes the override only after Save; collapsing a section does not save. **Default** identifies the inherited environment/application fallback value.

Screen refreshes preserve your position in Reports & Admin and other tab content. Returning an edited setting to its default value automatically marks it **Default** and removes the override when saved. Unsaved edits remain drafts until **Save Configuration** succeeds.

Two-choice configuration dropdowns mark the inherited choice with **(Default)**, for example **Enabled (Default)**. Select that option to return to the default; these fields have no reset button or override checkbox. Other fields retain **Return to default**. All edits still require **Save Configuration**, and changing choices preserves scrolling.

In **Raffle Bonus Tickets**, **Return to defaults** restores the full bonus configuration: Hours, Bonus %, and the enabled switch. Default rules restore both raffle types from their environment defaults; a selected raffle restores only that raffle’s inherited policy. The restored values are previewed and apply only after **Save Bonus Settings**. **Cancel default restoration** restores your previous draft. Scrolling is preserved during the preview.

Background roster and member-link broadcasts update cached client data without rebuilding Reports & Admin or other unrelated views. An open roster or member-link view refreshes when its data changes; unchanged broadcasts skip that redraw. An unchanged roster updates only its Last Refresh text. Background roster/link requests also leave unrelated settings content intact, preserving scrolling, focused inputs, and unsaved drafts in both web and desktop clients.

Discord and banking broadcasts, background availability polls, and refresh requests now update their visible data in place. Unchanged rows and cells remain intact; changed cells update, new entries appear, and removed entries disappear. Filters and sorting still apply. Counts, totals, refresh timestamps, bonus columns, export data, and mail availability controls update without rebuilding unrelated tabs or closing dialogs. Bonus settings can load and update in their own Reports & Admin section; unsaved bonus edits and reset previews are protected. Both web and desktop clients preserve scrolling, search inputs, and other unsaved form data.

Clicking Discord, Guild Roster, or Banking fetches a complete current dataset for that tab, including when you click the tab already open. Discord joins and departures update member rows automatically; ESO guild membership changes update roster rows after GuildSyncRoster sends them to the backend. Background membership updates preserve scrolling and open dialogs. Changes to raffle bonus settings refresh the affected banking ticket values, bonus columns, totals, and exports; an open bonus editor refreshes saved settings while preserving unsaved edits.

Administrator Configuration groups overrides by function and divides onboarding and raffle announcements into smaller labeled sections. Each setting has its own card with an explanation, its `.env` key, its current selection and Default/Overridden status, and its default controls. Hovering is not required to read help. Two-choice settings mark the default option; other settings show the default value and a Return to default button. Save Configuration applies your edits.


## Guild selection and replay

See [Guild identity, replay, and Discord colors](GuildSync-Guild-Isolation.md) for ESO `/gsr reset`, guild selection commands, and per-guild server configuration.
