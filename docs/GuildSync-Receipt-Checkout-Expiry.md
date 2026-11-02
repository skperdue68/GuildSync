# Receipt checkout expiration and offline ESO

## Unwritten checkouts

The client requests a **60-minute** checkout; the backend API default is 30 minutes when no duration is supplied.
Previously that expiration was recorded but never enforced.
With updated clients, an expired checkout that has not been handed to ESO becomes unsent and available to other senders again.
Expiration is checked on backend startup, banking refresh/broadcast, checkout, and handoff attempts. Connected clients normally poll availability every 30 seconds.

Before writing SavedVariables, the updated client must be connected and obtain backend authorization for the same owner/batch/event IDs.
It writes only records the backend still reserves for that sender.
If the batch expired or changed owner, the stale local pending batch is removed without writing any of those entries to ESO.
Offline clients cannot write a stale checkout when reconnecting later; authorization happens before each file-write attempt.

## Once handed to ESO

The backend moves an authorized batch to `written_to_eso` **before** the physical file write and clears its expiration.
This status therefore means reserved for the durable ESO handoff, not proof that the file write or email delivery succeeded.
A failed file write retains the local pending batch so the same sender can retry.

These handoffs do **not** automatically expire or get reassigned. The addon may already have sent mail while offline, with its acknowledgement still waiting for upload.
Reassigning such a batch could send duplicate receipts. Existing SavedVariables queue/ack entries are not deleted by the server.
An unavailable sender or lost local pending batch after handoff needs manual review before any reassignment; there is no automatic proof of non-delivery from an offline addon.

## Safe upgrades

Startup adds `guildsync_banking_entries.mail_handoff_version` (unsigned tiny integer, default 0).
Updated clients send `handoff_protocol: 1` on checkout. Only their unwritten, expired reservations can be released automatically.
Old clients wrote SavedVariables before asking the backend to mark the handoff, so their version-0 and existing reservations remain protected and do not auto-expire.
This prevents a backend upgrade from reclaiming an old client's possibly already-written mail.

Deploy the backend and rebuilt desktop/web clients. No environment setting, ESO addon change, or Google Apps Script update is required.
The desktop client remains responsible for editing SavedVariables while ESO is closed; the web client does not gain direct filesystem access.
