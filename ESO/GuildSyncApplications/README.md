# GuildSyncApplications welcome defaults

Open `/gsa settings` in ESO to edit, enable, disable, or delete welcome templates.
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
No backend, Discord bot, `.env`, or Google Apps Script changes are needed.

Developer check: from the repository root, run
`lua tools/applications-welcome-defaults.test.lua` (Lua 5.1 or newer).
