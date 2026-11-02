# Banking receipt checkout

Checking out receipt mail reserves the selected unsent raffle entries for the authenticated sender.
The backend selects candidates with `FOR UPDATE` inside a transaction and changes only rows still marked `unsent`.
Another sender cannot check out the same reserved entry. Partial checkouts leave other unsent entries available.

After a successful checkout, the backend broadcasts updated banking data to connected clients.
Their tab prompts count unclaimed (`unsent`) raffle mail only, so the prompt clears for the reserved entries, including on other screens.
Other available entries may keep the prompt visible. Disconnected clients receive the current state after reconnecting/refreshing.
Viewers cannot check out or send receipts and do not receive the mail-attention highlight.

This audit PR adds regression coverage for existing exclusivity behavior; it does not change checkout expiration or the mail queue.
Expiration and duplicate acknowledgement protection are separate changes.
