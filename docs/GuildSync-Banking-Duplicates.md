# Duplicate banking and receipt processing

Bank deposits are deduplicated by their event ID using the existing database primary key and `INSERT IGNORE`.
Re-uploading the same deposit preserves its mail state and does not enqueue a second initial Google Sheets export.
Sheet-export retries have their own durable queue/idempotence handling.

Receipt acknowledgements are checked against the authenticated checkout owner and stable `deposit_<event ID>` request ID.
The backend now locks those rows while confirming them and updates only checked-out/written rows, never a row already marked sent.
A repeated acknowledgement is still confirmed so the client can clear its local acknowledgement safely; it reports zero newly marked rows and preserves the original sent timestamp.

GuildSyncBanking also keeps local sent request IDs and acknowledges a previously sent request without calling SendMail again.
The backend does not itself send ESO mail and cannot synchronously query an offline addon.
This is not a guarantee against every external failure: the addon currently records a send when it calls ESO's SendMail, rather than independently proving final mail delivery.

Restart the updated backend. No schema migration, client/addon change, environment setting, or Apps Script update is required for this PR.
