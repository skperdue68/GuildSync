# Discord community activity

Approved design: replace slash-command rankings with Busiest Discord Users
(posts plus emoji reactions given), Most Posts, and Most Reactions Given.
Exclude bots, DMs, system messages, historical scans, and other guilds. Count
new events only. Preserve existing last-seen updates. Store identifiers and
display names, never message bodies, attachments, or component values.

Record each post once and each member/message/emoji reaction once; removing a
reaction does not subtract it and re-adding the same reaction does not inflate
the total. An idempotent startup-created activity table stores these events;
separate metadata records when this activity collection began. Old interaction
records remain retained but no longer drive the community report.

Membership rankings still require an actual recorded join event. Rename the
longest-membership heading and explain how many current members have no known
join date, without substituting potentially misleading snapshot dates.

Implementation and verification:
1. Add failing bot tests for post/reaction filtering, stable event IDs, and
   metadata-only payloads. Add failing backend tests for activity rankings,
   schema, write authorization/deduplication, and missing join coverage.
2. Implement the bot activity module and hook message/reaction listeners; remove
   slash telemetry hook. Extend backend schema, authenticated writer, and report.
3. Update both client coverage labels and operator/user documentation.
4. Run focused and complete bot/backend checks, build both clients, inspect
   diffs, and submit a separate pull request. Keep the primary checkout on master.
