# Public raffle summary cleanup

After a successful scheduled raffle-value announcement or public `/raffle`
summary, scan that channel's message history in pages of 100. Identify only
messages authored by this bot matching GuildSync's generated raffle-value
format. Keep the freshest data snapshot (newest message ID breaks ties) and delete the rest individually, including
messages older than Discord's bulk-delete window. Do not touch user posts,
other bots, ephemeral replies, private ticket reports, archive notifications,
or unrelated GuildSync announcements.

Publish before cleanup so a failed send never removes the existing summary.
Cleanup errors are logged without failing a successful publication or triggering
announcement retries. Reconciled scheduled deliveries also run cleanup.
Read Message History is necessary for scanning; deletion uses this bot's own
messages only. No new configuration or commands.

Write failing tests for safe message recognition, pagination, latest-message
preservation, delete/history failures, public command integration, and scheduled
announcement integration. Implement a shared helper, run focused/full bot tests,
document behavior, and create a separate PR without switching the main checkout.
