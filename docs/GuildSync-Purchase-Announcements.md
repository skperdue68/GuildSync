# Announce raffle values when purchases are recorded

Under **Reports and Admin > Administrator Configuration > Raffle announcements >
Schedule and destination**, enable **Update raffle values when ticket purchases
are recorded** and save. Administrator access is required to change this setting.
It takes effect without restarting the bot. Selecting the default value restores
the configured `.env` baseline through the normal configuration controls.

The optional bot setting is:

```env
GUILDSYNC_RAFFLE_ANNOUNCE_ON_PURCHASE=false
```

It defaults to disabled. The existing announcements enable switch and destination
channel are still required. When purchase mode is enabled:

- A new recorded purchase or correction to current raffle purchases triggers a
  fresh combined public raffle summary, even without a prize-threshold crossing.
- The recurring announcement interval and prize-milestone posts are suspended.
  Turning purchase mode off restores their saved settings; it does not erase them.
- Bonus deadline and sales-closing deadline reminders remain independently active.
- Duplicate uploads, receipt-mail acknowledgements, and checkout changes do not
  trigger extra posts. Several purchases processed together can share one post.
- Purchase changes arriving while the bot is already fetching/posting are checked
  again after that operation completes. Existing durable retry/reconciliation and
  public-message cleanup continue to apply.

This means **when GuildSync records the purchase**, not the moment gold enters ESO
before the addon upload. The bot rechecks on reconnect and periodic polling as a
fallback. Current-period purchases are fingerprinted separately from bonus policy
and non-ticket deposits; historical/other-period deposits do not change the active
raffle fingerprint. No member names or purchase IDs are included in wake events.

Deploy/restart both backend and Discord bot to install this feature. The setting
is supplied dynamically to existing clients, so a frontend rebuild is unnecessary.
No new dependencies, database tables, slash commands, or Google Apps Script changes
are required. Keep the announcement state file across upgrades for deduplication.
