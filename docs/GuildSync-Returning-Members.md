# Returning-member rank restoration

When GuildSync posts an **accepted** application to the configured Discord application thread, the backend searches roster event history for that exact ESO account (`@` and case differences are ignored).
It selects the latest recorded **rank change (promotion or demotion)** at or before the application's capture time. Later history is excluded when reposting an older application.
The most recent change wins, including a demotion after a promotion. No recorded promotion or demotion means no historical rank restoration; a new join/snapshot alone does not establish a previous rank.

The bot first uses the confirmed ESO/Discord account link. Without a confirmed link, it requires exactly one Discord member whose username, global name, or server nickname matches the ESO account exactly.
It never uses fuzzy/partial name matching or guesses between multiple links/members.

Automatic role changes require the authenticated application uploader (or the actual `/gsa` repost requester) to currently hold Consigliere or a higher recognized guild rank. A display name supplied in uploaded data cannot authorize role changes.
The restored rank cannot exceed that officer's own guild rank; higher ranks require review by a higher-ranked officer.
Older records without a verified uploader produce a manual-review notice; an officer can authorize a repost through the existing application-post command.

If a matching rank role exists, the bot adds it before removing lower guild-rank roles such as Gangsters and Associates.
A member who already holds a higher guild rank keeps it; the bot removes only lower recognized guild ranks.
Decorative/unrecognized roles are retained. Singular/plural guild rank names are matched consistently (for example Soldier → Soldiers).
The configured **Guild rank roles, lowest to highest** hierarchy (`GUILDSYNC_VOICE_MUTE_RANK_ROLE_IDS`) is honored even if voice muting is disabled.

The application post always opens with the returning member’s account name and recorded rank, for example `Prince-Alarming held AM Rank **Soldier** and should be promoted in game`, so officers do not have to look either up. It then says what happened on the Discord side: the account was promoted automatically to the recorded rank, already held the correct rank, already held a higher rank (which is never downgraded), or could not be identified for promotion. It tags the Consigliere role.
When the roster has no rank on record for the member, ESO is still the source of authority: nothing is restored, and the post reports the highest guild rank their linked Discord account holds instead — for example `has no ESO rank on record, but holds **Soldiers** in Discord and should be promoted in game to match`. That is advice only, because GuildSync cannot change ranks in ESO. It appears when the Discord rank is above the lowest configured rank; at the entry rank, with no rank role, or with no single link, the post asks an officer to confirm the in-game rank. A member counts as returning if they have any earlier roster activity, even when no promote or demote event was recorded for them.

If identity, roles, or bot permissions prevent restoration, the post explicitly requests manual review instead of claiming success.
Members not currently in Discord cannot receive a role; this feature reports that condition rather than queuing an automatic restoration for a future join.

The bot needs **Manage Roles** and a bot role above the ranks it grants/removes. It also needs application-thread posting permissions and permission to mention the officer role if that role is not otherwise mentionable.
The post allows only the intended officer-role mention; application text cannot trigger arbitrary mentions.
Repeated posts do not downgrade a member or stack lower guild ranks. `/gsa stop` also stops this workflow, because it runs as part of application posting.

Optional bot `.env` settings (restart bot after editing):

- `GUILDSYNC_APPLICATION_RESTORE_RANK_ENABLED=true`: defaults to enabled. Set `false` to retain ordinary application posts without automatic returning-rank restoration.
- `GUILDSYNC_APPLICATION_OFFICER_ROLE=Consigliere`: officer role name or numeric role ID, without `@`. Defaults to Consigliere; aliases such as Consiglieri are recognized.

For this rank-history correction, restart the updated backend; restart the bot too if deploying its revised audit wording. Startup automatically adds the nullable `guildsync_applications.submitted_by_discord_id` column to retain the authenticated uploader for pending broadcasts; existing application text/history is preserved. No client build, ESO addon, or Google Apps Script update is needed.
Application capture must be enabled in GuildSyncApplications for new captured applications to reach the backend; existing records can still be reposted.
