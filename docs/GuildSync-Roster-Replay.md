# Roster snapshots and replayed history

GuildSyncRoster keeps old streamed events so another upload can recover missed history. Those records are not a fresh list of current members.

Previously, replaying an already-stored join or promotion still changed the current roster. A missing member could therefore reappear after an authoritative guild-list refresh.

The backend now serializes imports, ignores duplicate event effects, stores newly found old history without changing newer membership, and rejects repeated/older guild-list snapshots. A snapshot older than already-applied membership events cannot rewind the roster.
Promotions and demotions update an existing member only; they never recreate an absent member.
A genuinely newer join, or a newer authoritative snapshot containing that account, can restore current membership.

To correct an already-inaccurate roster, run `/gsr guildlist` in ESO, then `/reloadui` to persist the fresh snapshot. The desktop watcher uploads it automatically when configured; web users can upload GuildSyncRoster.lua. Old saved history does not need to be deleted.

This change prevents re-import resurrection; it does not fabricate missing quit/kick history or identify a departure without a new snapshot/event.
Restart the updated backend. No database migration, addon change, environment setting, client rebuild, or Apps Script update is required.
