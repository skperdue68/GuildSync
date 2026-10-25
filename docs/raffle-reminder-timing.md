# Raffle sales reminder timing

Sales reminders use `salesEnd - leadHours * 3600`, independently of `drawTime`. Sales lead defaults to two hours; bonus lead defaults to one hour. Discord reminder headings display sales cutoff; raffle summaries separately display draw time.

`GUILDSYNC_RAFFLE_SALES_CLOSE_REMINDER_HOURS` accepts comma-separated positive hours. The live controller starts with the bot environment baseline, fills missing baseline values from configuration defaults, then applies saved administrator overrides. A saved `1` overrides a baseline `2`; deleting the override restores the baseline.

The scheduler checks on startup, reconnect and every five minutes while Discord and backend are connected. The warning window remains open from the lead boundary until sales close. Starting or reconnecting one hour before cutoff can therefore deliver a two-hour warning late. Persisted pending delivery retries can likewise arrive later within the window. Deduplication survives restart and pending warnings expire at sales cutoff.

Repository verification cannot establish the production cause. Compare saved administrator overrides, bot baseline environment, startup/connection times, persisted announcement state, Discord creation timestamp and backend salesEnd/drawTime snapshot. Do not publish secrets. Added tests verify the cutoff anchor and reproduce late startup delivery; they do not prove a production configuration failure.
