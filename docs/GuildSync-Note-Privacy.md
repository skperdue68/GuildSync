# Rank-based roster notes

New notes capture the authenticated author's Discord ID and highest recognized guild-rank role when saved.
The backend returns the text and note indicator count only to approved members at that guild rank or higher.
Lower/unknown ranks receive no note text, officer, timestamp, or count for restricted notes. GuildSync Admin status does not bypass Discord rank restrictions.
Viewers may read permitted notes but still cannot add them. Authors need User/Admin access and a recognized Discord guild rank.

The hierarchy uses **Guild rank roles (names or IDs, lowest to highest)** from Administrator Configuration (`GUILDSYNC_VOICE_MUTE_RANK_ROLE_IDS`), regardless of whether voice muting is enabled.
With no configured list, GuildSync recognizes Gangster, Associate, Soldier, Capo, Caporegime, Consigliere, Kingpin, including plural aliases. Decorative roles are ignored.
New notes retain their captured rank-role ID; later author demotion does not lower the note's threshold. Deleting/unrecognizing that role hides its notes rather than making them public.

Older notes did not record an author ID or rank. Their text is preserved, but access is conservatively limited to the highest configured guild rank (Kingpin by default).
Names alone are not used to guess a historical author's identity or rank. This may hide older notes from a Consigliere until their metadata is reviewed in the database.

The backend automatically adds nullable `author_discord_id`, `minimum_role_id`, and `minimum_role_name` columns to `guildsync_roster_member_notes` during startup. No notes are deleted or rewritten.
Roster counts are computed separately for each connected account; shared/import payloads always contain zero unfiltered counts.
Discord member/role updates refresh access, and updated clients discard previously loaded note text when access changes or the session disconnects.

Deploy the backend and rebuild both clients for the access-change cache clearing. Server-side filtering applies immediately after backend deployment, including to older clients' new requests.
No ESO addon or Google Apps Script update is required. Information already seen or copied before access was removed cannot be withdrawn.
