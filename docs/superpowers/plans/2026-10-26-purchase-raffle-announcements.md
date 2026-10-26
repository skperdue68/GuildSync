# Purchase-triggered raffle value announcements

User approved: add an optional switch beside the announcement schedule. When on,
recorded raffle ticket changes wake the bot immediately, replacing interval and
prize-threshold value announcements. Turning off restores their saved settings.
Keep explicit bonus and sales-closing deadline reminders separate. Default off.
Support administrator overrides and returning to the .env default without restart.

Use a metadata-only backend wake after banking broadcasts and a stable hash of
current purchase IDs, timestamps, paid tickets, and amounts in raffle snapshots.
Do not include acknowledgement state, bonus policy, or non-ticket deposits in
the hash. Compare with durable announcement state; unchanged snapshots must not
post. Preserve existing persisted delivery reconciliation and public cleanup.
Coalesce wakes during an active fetch/send and recheck after it finishes so no
new purchase is lost during an in-flight announcement. Keep periodic polling as
a fallback for lost notifications/reconnect.

Write red tests for fingerprint stability, optional mode/interval suppression,
restart deduplication, live configuration defaults/override/reset, and in-flight
wakes. Implement backend, bot, catalog/help and .env example; run focused/full
tests and client builds as appropriate; create one independent PR.
