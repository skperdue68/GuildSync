# GuildSyncApplications 1.4.5

Open `/gsa settings` in ESO to edit, enable, disable, or delete welcome templates.

The **Capture application data** toggle controls saving new accepted and rejected
application records. It defaults to enabled, including for existing installations
without `settings.captureApplicationData`. Disabling it preserves existing records
and keeps the accepted-member welcome chat and mail workflow active; failed
acceptances still skip welcome actions. Turn it back on to resume capture.

If you use this add-on with GuildSync, leave application-data capture enabled so application data can be copied automatically to Discord.
The add-on supplies five welcome chat messages and five welcome emails based on
the Alphabet Mafia templates. `{name}` is replaced with the applicant account name.

On the first load of this update, an empty message or email category receives its
defaults. Existing nonempty categories are preserved, including customized text,
disabled templates, and usage history. Defaults start with fresh usage counters;
no applicant records or account-specific history are included.

Initialization is recorded in `settings.welcomeDefaultsInitialized`. After that,
deleted templates stay deleted. If all templates are disabled or deleted, the
Classic Godfather message/email is used as the built-in fallback.

Install the updated `GuildSyncApplications` add-on folder and use `/reloadui`.
The add-on now retains separate decisions for an account that leaves and rejoins,
including multiple pending captures before the next upload. Existing account-keyed
SavedVariables entries remain readable; failed acceptances preserve older entries.
Install this add-on update to protect future captures. Previously overwritten text
cannot be recovered unless it survives in a SavedVariables backup or the database.

Deploy the matching backend and web/desktop client update to show the nearest
accepted application once per join (within seven days) and acknowledge each
application separately. Missing-action and legacy `processed` records remain eligible after confirmed
acceptances are matched; rejected
applications are excluded. Join matching is approximate because ESO exports no
application-to-join identifier. Desktop cleanup preserves pending data if ESO saves
the file again while an upload awaits confirmation; a fresh collection can retry.
No `.env`, Discord bot, or Google Apps Script changes are needed.

Developer check: from the repository root, run
`lua tools/applications-welcome-defaults.test.lua` and
`lua tools/applications-capture.test.lua` (Lua 5.1 or newer).
