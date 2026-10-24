# GuildSync user guide

Updated October 5, 2026. This guide covers the commands and systems in the current source, including optional member onboarding. A feature becomes available on your server after its changes are deployed and its administrator enables any required settings.

For setup, every environment setting, database details, and troubleshooting, see the [detailed reference](GuildSync-Detailed-Help.md).

GuildSync admins can review pending accounts, approve access, and maintain user profiles through **Manage GuildSync Users** in the top-right avatar menu. A numbered circle shows pending requests. See [managing GuildSync users](GuildSync-User-Administration.md) for instructions and account protections.

New accounts await approval as **Viewer** by default. Viewers can browse data, run reports, upload ESO history, and use automatic linking; **User** adds normal manual editing and receipt actions, while **Admin** also manages settings and accounts. Admins can test either lower role with **View as User / Viewer** in the avatar menu, then select **Return to Admin View**. Logging out resets the preview. See the [role permissions table](GuildSync-Roles.md).

## Installing on a Mac

The Mac installer is unsigned and runs in two stages. Follow the [Mac installation directions](GuildSync-Mac-Installation.md) for **System Settings → Privacy & Security → Security → Open Anyway**, then complete the application and ESO AddOns folder prompts after the Apple package finishes.

## What GuildSync does

Authorized Viewer, User, and Admin accounts in the Windows desktop client can optionally hold **Ctrl+M** (or a shortcut chosen in their avatar menu) to mute lower-ranked members in their current Discord voice channel. Releasing the keys or leaving ends the session; moderator mutes are preserved. An administrator must first enable it and select allowed Discord roles. See [Voice Channel Mute](GuildSync-Voice-Mute.md).

GuildSync connects your guild's ESO activity with Discord and the raffle spreadsheets. It collects guild bank deposits and roster changes, keeps the records in a database, and uses those records to show raffle tickets, fill spreadsheets, and prepare receipt mail. It also helps officers review applications and match Discord members with ESO accounts.

Data appears after an officer's ESO add-ons save it and the GuildSync desktop app uploads it. GuildSync does not query the live ESO bank when you run a Discord command.

## Discord: commands for members

Type these in your guild's Discord server. In the examples, text after a colon is a Discord command option.

| Command | What it does |
| --- | --- |
| `/raffle` | Privately shows the current Bi-Weekly and 50/50 raffles, prizes, tickets, draw times, available early purchase bonus, and latest recorded transaction time for each raffle period. |
| `/raffle public:true` | Shows the raffle summary publicly in the channel. |
| `/tickets` | Privately shows the raffle summary and your current ticket purchases for your linked ESO account. |
| `/raffle tickets:true` | Does the same ticket lookup as `/tickets`. |

Raffle summaries, ticket lookups and automatic channel announcements show both the current **As of** time and the **Latest recorded transaction** for each raffle period. These transaction dates describe the latest entries recorded by GuildSync automation, which may lag behind actual deposits; they do not confirm that all ESO deposits have been uploaded. Empty periods say no transactions are recorded. Discord displays the dates and times in your local timezone.

Ticket details are private even if you also choose `public:true`. Bi-Weekly and 50/50 purchases appear separately. When a purchase earned a bonus, its percentage appears with bonus and total tickets.

If your tickets cannot be found, check that your Discord account is linked to your ESO account and that recent deposits have been uploaded. Matching your server nickname to your ESO account helps the matching process. Ask an officer to review the link if it still does not work.

## Discord: raffle commands for Consigliere

These require the Discord role named exactly **Consigliere**. `/gsr` is a shorter name for `/gsraffle`; both do the same thing.

| Command | What it does |
| --- | --- |
| `/tickets verify:AccountName` | Privately checks current tickets for an ESO account. Enter the account name without `@`, a mention, or a link. |
| `/raffle verify:AccountName` | The same officer ticket lookup. |
| `/gsr load` | Clears and refills the current working raffle sheets from the database, including saved result fields. Returns an **Open Working Raffle** button. |
| `/gsr load date:092526` | Loads the raffle containing September 25, 2026. Historical raffles use their archived spreadsheet, leaving the current working sheet alone. Creates an archive if needed. |
| `/gsr update date:092526` | Saves winners, attendance, and other supported result fields from that archived sheet back into the database. It does not clear the sheet or import ticket purchases. |
| `/gsr archive` | Archives the current raffle sheet, saves its supported result fields, resets both working tabs, and repopulates current raffle data. Returns buttons for the archive and working sheet. |
| `/gsr reset` | Clears managed data and draw dates on both working tabs without deleting database records. Use `load` afterward to restore data. |

Dates use zero-padded **MMDDYY**: `100326` means October 3, 2026. You can also enter `10/03/26` or `10-03-26`; GuildSync converts them automatically. If zeros are missing and the date can be determined safely, it shows the full date and asks you to **Confirm date**. For example, `9/5/26` or `9526` becomes `090526`. An ambiguous value such as `11226` fails: enter `011226` for January 12 or `110226` for November 2. Invalid dates also fail with the required format. The year must have two digits. Canceling or ignoring the confirmation for one minute changes no data. If your date is the start/end boundary of a Bi-Weekly raffle, choose **Starts on this date** or **Ends on this date** when asked. GuildSync selects the corresponding 50/50 raffle for you. You have one minute to answer; no answer cancels the operation.

To edit an old raffle:

1. Run `/gsr load date:MMDDYY` and answer any boundary question.
2. Open the returned archive button. Review or edit the supported winner, attendance, bonus-ticket, or winnings-sent fields.
3. Run the **update command shown in the response**, using the normalized, zero-padded date and the same boundary choice.

Existing historical files keep their file ID during load and update. Archive filenames use the Bi-Weekly ending date: **YYMMDD Raffle**, such as `261010 Raffle` for October 10, 2026. Archiving the live sheet again can replace an older same-name archive and give that replacement a new link.

Loading rebuilds the managed fields. Update an edited historical archive before loading it again if you want to explicitly save your edits. An existing ready archive is also read before a historical reload, but `update` is the deliberate save operation.

If a command times out, ask the operator to check the logs before retrying: the operation may still be running. Archive errors leave records in the database and pause the reset until recovery succeeds.

## Discord: synchronization and applications

| Command | What it does / access |
| --- | --- |
| `/roles` | Refreshes Discord roles and members in GuildSync. Discord defaults access to members with **Manage Roles**. |
| `/gsa post name:AccountName` | Reposts saved ESO application decisions matching a full or partial account name to the configured application thread. |
| `/gsa stop` | Pauses automatic application posts to Discord. |
| `/gsa start` | Resumes automatic application posts. |

The administrator should restrict `/gsa` through Discord's command permissions if only officers should use it. GuildSync currently has no built-in officer check for those three application commands. Stopping automatic posts does not block a manual `post`; restarting the bot enables automatic posting again.

## ESO: commands typed in game

These are **ESO chat commands**, not Discord commands. In particular, ESO `/gsr` manages the **roster**, while Discord `/gsr` manages **raffles**.

### GuildSyncBanking

Banking collection starts automatically when its history library is ready. It records gold deposits for Alphabet Mafia.

| ESO command | What it does |
| --- | --- |
| `/gsb` or `/gsb help` | Shows banking command help. |
| `/gsb status` | Shows whether collection is running and its saved progress. |
| `/gsb stream` | Starts or resumes collection. |
| `/gsb stop` | Stops collection. |
| `/gsb dump` | Prints matching cached deposits for inspection; does not collect or save them. |
| `/gsb reset` | Restarts history collection from the beginning. Existing event IDs prevent saved duplicates. Use for recovery when directed by an operator. |
| `/gsb debug on` / `/gsb debug off` | Enables/disables extra in-game banking output. |

### GuildSyncRoster

Roster collection also starts automatically when its history library is ready.

| ESO command | What it does |
| --- | --- |
| `/gsr` or `/gsr help` | Shows roster command help. |
| `/gsr guildlist` | Captures the current member list and ranks. |
| `/gsr stream` | Starts or resumes collection of roster events. |
| `/gsr stop` | Stops collection. |
| `/gsr dump` | Prints cached matching events without saving them. |
| `/gsr debug on` / `/gsr debug off` | Enables/disables extra in-game roster output. |

### GuildSyncApplications

| ESO command | What it does |
| --- | --- |
| `/gsa` or `/gsa help` | Shows application add-on help. |
| `/gsa settings` | Opens welcome-message and welcome-email settings. Create, enable/disable, edit, and save your templates here. |
| `/gsa list` | Prints saved application decisions. |

The application add-on records accept/decline/reject actions performed through ESO's application interface. After an accepted applicant's membership is confirmed, it sends a welcome mail. For an online applicant, it prepares welcome text in **officer chat** and plays an alert; the officer presses **Enter** to send that chat message. `{name}` in a welcome template becomes the applicant's account name.

Use ESO's normal `/reloadui`, logout, or exit to save add-on data to disk so the desktop app can upload it. Receipt mail is different: **close ESO completely** when GuildSync needs to write a queued mail batch, then reopen ESO to send it.

## Buying tickets and early purchase bonuses

Deposit gold into the guild bank using the appropriate marker:

| Raffle | Examples |
| --- | --- |
| Bi-Weekly | `501` gold buys 1 base ticket; `1001` buys 2. Base cost is 500 gold per ticket plus 1 gold per deposit. |
| 50/50 | `2503` gold buys 1 base ticket; `5003` buys 2. Base cost is 2,500 gold per ticket plus 3 gold per deposit. |

Other gold deposits are recorded as other deposits. Bonus tickets do not add prize gold.

Early purchase bonuses are optional and can be enabled separately for each raffle type or individual raffle. The administrator sets the time periods and percentages in GuildSync's **Raffle Bonus Settings**. Earlier purchases can receive higher bonuses; the final period has 0%. Bonus tickets round down **for each purchase**. For example, 5 purchased tickets with a 20% bonus earns 1 extra, for 6 total. Manually added ticket entries do not earn an additional early purchase bonus.

When a purchase has a positive bonus percentage, its ESO receipt includes the percentage, the buy-before deadline, bonus tickets, and total tickets. At 0%, that section is omitted. The settings selector marks enabled raffles **(Bonuses)** and removes that label when disabled.

## What happens to the spreadsheets

The current working file is reused. New uploaded purchases are written only when they belong to the raffle shown by that tab's draw date. Purchases for another period stay in the database until that period is loaded; they are not lost.

Archiving copies the workbook into the archive folder, captures supported results, and only then resets and reloads both working tabs. Bi-Weekly attendance/bonus cells have fills and other managed formatting cleared while **borders remain**. An ongoing 50/50 raffle is repopulated after a Bi-Weekly archive too.

Automatic archiving is optional. When enabled, spreadsheet writes pause at sales cutoff while purchases continue to enter the database. After the configured delay, normally four hours, GuildSync archives and reloads. A Consigliere can use `archive` to complete that rollover sooner. Public raffle announcements and archive notifications are also separate optional features.

## Joining Discord and gaining access

If onboarding is enabled, members with **Gangsters** are promoted to **Associates** after a confirmed Discord-to-ESO link is made. GuildSync adds Associates, removes Gangsters, and retains unrelated roles. If you already have Soldiers, Capo, Caporegime, Consigliere, Kingpin, or a matching singular/plural role, GuildSync removes only Gangsters and preserves your existing rank without adding Associates or sending an Associate-promotion message. Your ESO rank is not changed by this feature. The server's Associates permissions determine your access.

GuildSync tags you in an account-linked message. It normally uses a private thread in the configured onboarding channel. If private-thread creation is unavailable, it creates a **public thread in that same channel**; members who can view the channel may see it. Staff with appropriate moderation permissions can view private threads too. No direct messages are sent.

Members who join after reminders are enabled and remain unlinked receive one reminder after the configured delay, normally 24 hours. Existing members are not enrolled just because the feature was enabled. The reminder is once per Discord member, including after leaving/rejoining. Role promotion, promotion messages, and reminders each have their own switches; ask an administrator if the feature is unavailable.

## Using the desktop app

Sign in through Discord using your authorized GuildSync account. Use **Discord Member Data**, **Guild Roster**, and **Bank Deposits / Raffle Tickets** to browse the records. Officers can review account links, member history, deposits, applications, and reports according to their GuildSync access.

In the profile settings, each add-on file watcher can be switched on or off. Disabled watchers do not upload that file. The desktop app performs local ESO uploads and queues receipt mail; the browser view is for server data and does not watch local ESO files.

If something seems missing, check upload status, save ESO data with `/reloadui`, and confirm the right raffle period/account link. For setup or persistent errors, use the [detailed help and troubleshooting reference](GuildSync-Detailed-Help.md).


## Reports & Admin settings

**Raffle Bonus Tickets** and **Administrator Configuration** now open by clicking their headings. Opening another section or report closes the previous section. Closing a section keeps your unsaved edits.

GuildSync administrators can configure onboarding, raffle announcements, archive notifications, spreadsheet automation, and receipt templates under **Administrator Configuration**. Each field identifies its effective value and whether it is **Default** or **Overridden**. Edit a field directly; no checkbox is required. **Return to default** schedules removal of the override. Other fields show the selection and default side by side. All controls use consistent wording: **Enabled** or **Disabled** for switches. Click **Save Configuration** to apply either choice; closing the section does not save.

Settings apply without restarting the backend or connected bot. Active operations finish safely before switching settings; an offline bot uses saved settings when it reconnects. A rollover already on hold keeps its original deadline.

Bonus settings have their own **Save Bonus Settings** button. **Return to default** restores upcoming/default policies; **Return to raffle default** restores the saved policy for that particular raffle. Both require Save. Completed raffle policy history is retained.

See [configuration details](GuildSync-Admin-Configuration.md) for the full setting list and setup requirements.

Screen refreshes preserve your position in Reports & Admin and other tab content. Returning an edited setting to its default value automatically marks it **Default** and removes the override when saved. Unsaved edits remain drafts until **Save Configuration** succeeds.

Two-choice configuration dropdowns mark the inherited choice with **(Default)**, for example **Enabled (Default)**. Select that option to return to the default; these fields have no reset button or override checkbox. Other fields retain **Return to default**. All edits still require **Save Configuration**, and changing choices preserves scrolling.

In **Raffle Bonus Tickets**, **Return to defaults** restores the full bonus configuration: Hours, Bonus %, and the enabled switch. Default rules restore both raffle types from their environment defaults; a selected raffle restores only that raffle’s inherited policy. The restored values are previewed and apply only after **Save Bonus Settings**. **Cancel default restoration** restores your previous draft. Scrolling is preserved during the preview.

Background roster and member-link broadcasts update cached client data without rebuilding Reports & Admin or other unrelated views. An open roster or member-link view refreshes when its data changes; unchanged broadcasts skip that redraw. An unchanged roster updates only its Last Refresh text. Background roster/link requests also leave unrelated settings content intact, preserving scrolling, focused inputs, and unsaved drafts in both web and desktop clients.

Discord and banking broadcasts, background availability polls, and refresh requests now update their visible data in place. Unchanged rows and cells remain intact; changed cells update, new entries appear, and removed entries disappear. Filters and sorting still apply. Counts, totals, refresh timestamps, bonus columns, export data, and mail availability controls update without rebuilding unrelated tabs or closing dialogs. Bonus settings can load and update in their own Reports & Admin section; unsaved bonus edits and reset previews are protected. Both web and desktop clients preserve scrolling, search inputs, and other unsaved form data.

Clicking Discord, Guild Roster, or Banking fetches a complete current dataset for that tab, including when you click the tab already open. Discord joins and departures update member rows automatically; ESO guild membership changes update roster rows after GuildSyncRoster sends them to the backend. Background membership updates preserve scrolling and open dialogs. Changes to raffle bonus settings refresh the affected banking ticket values, bonus columns, totals, and exports; an open bonus editor refreshes saved settings while preserving unsaved edits.

Administrator Configuration groups overrides by function and divides onboarding and raffle announcements into smaller labeled sections. Each setting has its own card with an explanation, its `.env` key, its current selection and Default/Overridden status, and its default controls. Hovering is not required to read help. Two-choice settings mark the default option; other settings show the default value and a Return to default button. Save Configuration applies your edits.

Approved GuildSync users can view **Administrator Configuration** and **Raffle Bonus Tickets**. Users see read-only values and defaults, can refresh configuration, and can select a raffle to inspect its bonus rules. Only GuildSync administrators can change, reset, or save either section. These login permissions are separate from Discord roles.



## Guild selection and replay

See [Guild identity, replay, and Discord colors](GuildSync-Guild-Isolation.md) for ESO `/gsr reset`, guild selection commands, and per-guild server configuration.


## Community highlights and automatic Sheets recovery

See [community highlights and spreadsheet recovery](GuildSync-Community-Statistics.md) for the Reports and Admin statistics, their historical coverage, new database tables, automatic raffle export retries, and Linux troubleshooting.


## Keeping public raffle information current

When the bot posts a scheduled raffle-value summary or you run `/raffle public:true`, it scans that same channel and removes its older raffle-value summaries. The summary with the freshest data remains; ties keep the newest post. This also cleans up summaries posted before the update. Private ticket replies, archive notifications, other announcements, and messages from people or other bots are preserved.

The bot needs Read Message History in that channel. Cleanup problems are reported in the bot logs; the new summary remains available. No additional setting is required.
