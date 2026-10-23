# Guild identity, replay, and Discord colors

Use one backend, Discord bot process, and database per guild. This reuses the existing single-guild design without adding tenant administration. Give each instance its own `MARIADB_DATABASE`, ports, Discord guild configuration, and spreadsheet configuration. Do not share a SavedVariables upload queue between instances for different guilds.

## ESO collection and replay

LibHistoire supplies the actual ESO guild ID when a processor is created. Roster and banking exports now retain that ID and guild name on each event; roster snapshots retain them too. Applications already include guild identity on individual decisions. ESO guild IDs are different from Discord server IDs.

| ESO command | Purpose |
| --- | --- |
| `/gsr status` | Show the roster guild, ESO ID, checkpoint, and stream status. |
| `/gsr reset` | Replay available cached roster history for the selected guild. Pending exports and other guild checkpoints remain intact. |
| `/gsr guild <name or ESO guild ID>` | Persist the roster collection guild. Pending events and snapshots must upload first. |
| `/gsr guildlist` | Capture a fresh roster snapshot. |
| `/gsb status` | Show banking guild, ESO ID, and checkpoint. |
| `/gsb reset` | Replay available cached banking history for the selected guild. Pending deposits and receipts remain intact. |
| `/gsb guild <name or ESO guild ID>` | Persist the banking collection guild after pending deposits and receipt acknowledgements finish. |

These are ESO add-on commands; the Discord `/gsr` command is separate. Reset replays LibHistoire's available cache, not an unlimited request for all historical events. Database duplicate checks still apply. Checkpoints are now separated by ESO guild ID. A legacy checkpoint without a known guild is retained for reference and replay begins safely instead of assuming its guild. Existing pending records are never relabeled.

Use `/gsa guild <name or ESO guild ID>` to select the applications capture guild after pending decisions upload. Unselected applications retain legacy capture behavior. Selecting a guild also directs officer welcome messages to that guild; customize welcome templates through `/gsa settings`. Strict isolation rejects mixed-guild application batches rather than acknowledging another guild’s records.

## Backend configuration and rollout

`GUILDSYNC_ESO_GUILD_ID` is optional for compatibility. Leave it empty for legacy behavior; set it to the numeric ESO guild ID to enforce origin checks for banking, roster, and applications. If `GUILDSYNC_APPLICATIONS_GUILD_ID` is also set, it must match. This value is a backend environment setting and requires a restart.

Before enabling strict checks, back up and review the existing database, upload all old pending exports, update both add-ons and the desktop client, then capture a new roster snapshot. Untagged legacy records are rejected in strict mode; they are not guessed or retagged. Existing historical database rows are not retroactively verified.

Startup binds the database to the configured ESO guild in `guildsync_settings` under `eso_guild_id`. A bound database cannot be switched to another guild or returned to legacy mode merely by changing the environment. Create a separate database for another guild. Invalid or mixed batches fail before writes and are not acknowledged for cleanup.

Set the bot's `DISCORD_GUILD_ID` explicitly for each instance. Authenticated bot role/member updates for another Discord server are rejected by the backend. This prevents a bot connected to multiple servers from mixing their roster data.

## Discord colors

Startup adds `discord_roles.role_position` if needed. Update and restart the bot and backend, resynchronize Discord roles/members, and rebuild the desktop and web clients. Discord rows use the highest positioned role with a nonzero Discord color. ESO roster ranks and filter chips resolve their corresponding Discord roles, including singular/plural rank aliases, instead of using fixed rank colors. Role updates refresh relevant rows and chips without rebuilding unrelated screens.

No Google Apps Script update is needed for these changes.

## Roster filters

Selected Discord roles match **any** selected role (OR), just as selected ESO ranks do. Search and link-status filters still narrow those results. For ESO rank color matching, canonical Discord role aliases such as Associates and Soldiers take precedence over conflicting singular roles; singular roles remain a fallback when the plural role is absent. Rows and rank chips use the same lookup. No colors are fixed in code.
