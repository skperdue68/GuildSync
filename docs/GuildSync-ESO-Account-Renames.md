# ESO account-name changes

Admins and Users can update an ESO account name from **Guild Roster → member history** (the history icon or the history search). Viewers can read history but cannot rename accounts. These are GuildSync access roles, independent of Discord guild ranks.

1. Open the member’s history and select **Change ESO account name**.
2. Enter the new ESO account name, with or without the leading `@`.
3. Select **Preview change** and review the affected roster/history, Discord links, banking, applications, and GuildSync account records.
4. Select **Confirm name change**. Cancel leaves the account unchanged.

A permanent history event records **ESO account name changed from @OldName to @NewName by Operator**, with the date/time displayed in the viewer’s local timezone. The audit also retains the original administrator ID when acting as another account. Existing rank, membership dates, notes and note-access restrictions, purchase amounts, application captures, receipt status and confirmed Discord links are preserved.

Old names remain searchable in the roster, member-history search, banking-history search and application search. Imported roster snapshots, roster events, banking and applications using an old name are resolved to the current name. Original recorded names are kept separately; roster history and join application text show the original name when different. Returning-member rank lookup follows the same identity. Renaming does not post a new accepted application, grant Discord roles, or create a join/promotion event.

## Conflicts and confirmations

A destination already associated with another identity or containing records is blocked. GuildSync does **not** silently merge accounts or delete either account’s history. Review the destination member/history separately before proceeding; combining existing identities is not provided by this feature. If the new name has already been imported as a separate member, it will require a separately reviewed consolidation rather than deleting history to bypass this protection.

Former names remain reserved as aliases. Reuse of an old name by a different person must be reviewed; do not assume two people are the same member because their names match.

Confirmations expire after five minutes and belong to the login session and selected names. A backend restart, changed preview counts, another rename, or lost access requires a fresh preview. If a member has checked-out or already-written ESO receipt mail, finish that handoff first. Rename will not modify an existing SavedVariables outgoing-mail queue.

A rename updates GuildSync’s database and current client data. It does not change the person’s actual ESO name, their Discord username, application free text, old installer files, or already populated Google spreadsheet/archive cells. Subsequent database loads use the current name.

## Deployment and storage

Deploy the updated backend, rebuild/deploy the web client, and distribute a rebuilt desktop client for its new controls. Restart the backend. **No ESO addon or Google Apps Script update is required.** There are no new `.env` settings.

Startup automatically creates and backfills the following tables:

- `guildsync_eso_members`: stable `member_id`, current name and normalized unique name key. Existing names receive IDs at startup; an account first seen afterward is assigned an identity on rename or the next startup.
- `guildsync_eso_account_aliases`: unique normalized old/current name → stable member ID. Repeated renames retain every alias.
- `guildsync_eso_account_renames`: immutable rename ID, member ID, old/new names, effective operator ID/name, original actor ID, and Unix timestamp.

Nullable original-name columns are added to roster events, roster notes, banking entries and applications; structured officer references on events/applications also retain originals. Existing operational account-name keys are updated transactionally so existing reports and lookups stay compatible. Free-text notes/applications are never searched-and-replaced.

Rename and relevant imports/edits use a database-scoped named lock, and all rename updates plus the audit commit in one transaction. If any step fails the rename rolls back. Incoming event IDs and application capture timestamps remain the replay/duplicate identifiers. An existing application broadcast acknowledgement follows aliases so an old-name acknowledgement does not leave a renamed application pending.

Back up the database before deploying any schema update. Test a known member rename and search both names after deployment. Automated tests exercise the transactional SQL through a SQLite compatibility adapter; production MariaDB and live Discord/Google Sheets are not contacted by the test suite.
