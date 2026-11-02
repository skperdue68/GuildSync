# Application text in member history

Open **Guild Roster → Lookup Roster History**, search for an ESO account, and select it.
Each recorded **joined** event shows the application text beneath it automatically.
There is no extra roster button or application popup. Former members can be found through the same history search.

Applications are matched to the exact ESO account (case insensitive, with or without `@`).
For accounts with multiple joins, the nearest recorded application within seven days before or after a join is used.
Each application is matched once, so a later rejoin does not reuse an old application.
The application capture date is shown in the viewer's local time. This is a proximity match because existing application imports do not contain a roster-event ID.

If there is no nearby application text, the history explicitly says **No application text recorded near this join**.
A failed history request is shown as a loading failure rather than claiming there is no application.
GuildSync cannot reconstruct text that was never captured by GuildSyncApplications.

Approved Viewers, Users, and Admins may read this information. The backend rechecks current account approval before returning application history.
This is read-only and does not repost applications to Discord or change their processing/broadcast status.

Deployment: restart the updated backend, build/deploy the web client, and distribute a rebuilt desktop client.
There are no new environment settings, database migrations, ESO addon changes, or Google Apps Script changes for this feature.
