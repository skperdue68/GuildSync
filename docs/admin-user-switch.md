# Admin account switching

## Using the profile menu

Sign in as a GuildSync Admin, open your top-right avatar menu, and choose an approved account from **Act as account**. Pending and revoked accounts are excluded. The avatar/profile and ordinary permissions become those of the selected account. Open the menu and choose **Return to my account** to finish; the return control remains available when acting as a Viewer. This is available to currently approved GuildSync Admins, independently of Discord rank.

This performs real actions with the selected user's allowed capabilities, including data edits. Discord-rank note filtering uses the selected Discord account. It does not grant your Admin role to the selected account or change anyone's stored role. Account management remains available only when the selected account itself is an Admin. Return to yourself before editing your own account.

All browser tabs/clients sharing this exact login token switch together; a separate login is independent. Logging out and logging in again starts as yourself. A backend restart also returns you to yourself. Actor demotion or target revocation ends the switch; revoking the real actor ends the login.

## Session validation and audit

Startup creates **guildsync_user_switch_audit** in the login database. It records the real actor ID, selected target ID, a SHA-256 session reference, action, reason/event name, and timestamp. Session credentials and action payloads are not stored. Operation entries describe attempted dispatch, not a promise that a later database/Discord operation succeeded.

Actor approval/Admin status, target approval, and the original login session are checked server-side. Switching stores no target OAuth token. No environment setting or manual migration is needed. Deploy the updated backend and rebuild web/desktop clients together. No ESO addon, Discord bot, or Google Apps Script changes are required.


The avatar menu uses server-provided `user_switch` actor metadata to expose an approved-account dropdown. While active, it shows the target name and **Return to my account**, including for a Viewer. Ordinary features use the effective target role only. The original session token remains unchanged.

Identity changes invalidate socket acknowledgements using a session generation, clear member, roster, notes, report, bank and management state, and reconnect with the original token. Community statistics keys include identity and generation. Desktop SavedVariables ingestion, mail handoff and voice hotkeys pause during switching. An active mute release must be acknowledged before changing identity. Native work rechecks identity before committing ESO files. A native operation already submitted before the switch may finish; pending queues are retained for safe retry after returning. If backend verification is unavailable, the desktop does not start from an unverified cached profile.

## Restoring the former role preview

Both clients retain `src/role-view-controls.js`, `changeGuildSyncRoleView`, their event wiring, and the `.profile-role-view-*` / `.profile-test-mode-section` rules in `src/user-administration.css`. The former menu section was rendered with `${renderRoleViewControls(guildSyncSession.user)}` inside `renderOpenProfileMenuContents`. Restore that expression to restore the previous View Test Mode appearance (View As User and View As Viewer buttons; preview shows the spacer and Return to Admin View). Account switching currently renders `renderUserSwitchControls` in its place. The preserved renderer tests document its exact markup.


The former section appeared in the top-right avatar menu under **View Test Mode**. Two compact buttons sat side by side: **View As / User** in blue (`#245cbb`) and **View As / Viewer** in purple (`#7040a4`), with two centered text lines. Preview replaced them with a blue **Return to Admin View** button and a small vertical spacer. The original CSS retains the two-column grid, centered alignment, colors and hover states.
