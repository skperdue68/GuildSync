# Managing GuildSync users

Open your Discord avatar menu in the upper-right corner and select **Manage GuildSync Users**. This option is visible only to approved GuildSync admins. A numbered circle on the avatar shows accounts awaiting approval. The menu labels your GuildSync access level as **Role**; this is separate from your Discord rank.

Search by name, email, role, or Discord ID. **Show** offers **Current accounts**, **Pending approval**, and **Revoked accounts**. The default Current accounts list includes approved and pending users, while revoked users appear only in the Revoked accounts view. Each record shows the account's Discord identity, guild member name, email, role, approval status, request date, and last login; revoked records also show their revocation date.

- **Approve account** grants access. New pending accounts default to **Viewer**. Select **User** for normal data editing or **Admin** for administrative access. See the [role permissions](GuildSync-Roles.md).
- **Save changes** updates the email, guild member name, and selected role. Saving a pending record does not approve it; use **Approve account** for that.
- **Revoke account** asks for confirmation, sets `allowed=0`, clears saved sessions, and disconnects active clients. The account record and its links to banking history remain intact. Revoked accounts are hidden from Current accounts and the pending approval count; select Revoked accounts to review them. Their next Discord login returns the retained account to pending approval, with Viewer selected by default; it does not restore access automatically.
- **Reinstate account**, available to Admins in the Revoked accounts view, restores access to the same account. It defaults to the retained role; select a different role before reinstating if needed. Any edited email and guild member name are saved with reinstatement. The revocation marker is cleared, approval and request timestamps are renewed, and old sessions remain invalid. The user must sign in again. Reinstated users return to Current accounts and do not appear in the pending count.

You can edit your own email and guild member name, but cannot change your own role or revoke your own account. These restrictions are enforced on the server as well as in the interface. Another admin can change your role or revoke your account.

GuildSync admins can change both administrator configuration and raffle bonus configuration. Approved Viewers and Users can view these sections but cannot save or reset them. Viewers can browse data, run reports, upload ESO history, and use automatic linking, but cannot manually edit links, banking entries, or notes or process receipts. Account management itself is restricted to admins. The same avatar menu offers Admin-only account switching; see [account switching](admin-user-switch.md).

## Updates and unsaved edits

Pending counts update when accounts change, when new login requests arrive, on reconnection, and once a minute while connected. Background notifications preserve account edits and do not refresh other screens. **Refresh list (discard edits)** reloads current records. If another admin changed the same record, saving fails with a request to refresh rather than silently overwriting their edits.

Role changes update active client permissions. The backend checks the current database role for every account-management request. Revoking an account also invalidates legacy login tokens through the approval check and a renewed request timestamp when the person requests access again.

## Storage and deployment

Records remain in the existing login database table **`guildsync_users`**. Editable fields are `email`, `guild_member_name`, and `role`; approval also updates `allowed` and `approved_at`. Revocation sets `allowed=0` and `revoked_at`, preserves the other account fields, and clears associated rows in **`guildsync_login_sessions`**. Startup automatically adds the nullable `revoked_at` column to existing databases; no manual migration, new table, or environment setting is required. Pending accounts with `allowed=0` and no revocation marker remain visible for approval. A new Discord login clears the marker, renews `requested_at`, clears `approved_at`, and selects Viewer while leaving access disabled. Startup also sets the role column's insertion default to Viewer without changing existing account roles.

Discord supplies the initial email on first login. Subsequent logins preserve the stored email, including a blank email entered by an admin. Discord username, global name, and avatar continue to update from Discord.

Deploy the updated backend and web assets, then restart the backend. Desktop users need the updated client build. No Google Apps Script deployment changes are needed.
