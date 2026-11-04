# GuildSync account roles

GuildSync account roles control the desktop and web application. They are separate from Discord ranks and ESO guild ranks; changing a GuildSync role does not change the member's Discord roles or slash-command permissions.

| Capability | Viewer | User | Admin |
| --- | --- | --- | --- |
| Browse Discord members, roster, banking data, notes, and history | Yes | Yes | Yes |
| Run reports, filter data, and export banking data locally | Yes | Yes | Yes |
| Inspect raffle bonus policies and administrator configuration | Yes | Yes | Yes |
| Create, approve, remove, or unblock ESO/Discord links manually | No | Yes | Yes |
| Run automatic ESO/Discord linking or Discord synchronization | Yes | Yes | Yes |
| Add manual banking entries or move entries | No | Yes | Yes |
| Add roster notes | No | Yes | Yes |
| Upload ESO banking, roster, and application history | Yes | Yes | Yes |
| Check out or process deposit receipt mail | No | Yes | Yes |
| Save/reset raffle bonus policies or administrator configuration | No | No | Yes |
| Review, approve, edit, or remove GuildSync login records | No | No | Yes |

Viewers can refresh tabs, upload ESO history through GuildSyncBanking, GuildSyncRoster, and GuildSyncApplications, and run automatic linking. On ESO, `/gsbanking`, `/gsroster`, and `/gsapplications` still gather information for their corresponding add-ons; the approved GuildSync account then uploads it to the database. This can add ticket purchases and roster join/leave events. Viewer access does not permit manual links, unlinking, manual banking entries, moving entries, notes, or receipt checkout/processing. Viewers do not see the pending-receipt counter or highlighting. The interface and backend enforce these restrictions.

## Admin account switching

The top-right avatar menu lets an approved Admin select an approved GuildSync account under **Act as account**. GuildSync uses that account's interface, permissions, and Discord rank for note visibility. **Return to my account** restores the real administrator, including when the selected account is a Viewer. The actual administrator remains authenticated and is recorded in the switch audit. Ordinary features do not inherit the real actor's Admin permissions.

The former View as User/Viewer controls are hidden while their implementation and styles remain available. See [account switching](admin-user-switch.md) for lifecycle, deployment, audit storage, native pauses and restoration instructions.

## New accounts and approval

The first Discord login still creates an approved **Admin** when no approved administrator exists. Once an administrator exists, new accounts have **Viewer** selected and remain **pending approval** (`allowed = 0`). An admin uses **Manage GuildSync Users** in the avatar menu to choose **Viewer**, **User**, or **Admin** and approve the request. Merely changing a pending account's role does not approve it.

Existing accounts keep their roles. Legacy pending records show Viewer as their approval default. Admins can change another account's role at any time, but cannot change their own role or revoke their own access. Role changes update connected clients; backend write requests recheck the current approved role in the database, so cached permissions cannot authorize an old role's writes.

## Storage and deployment

The roles are stored in **`guildsync_users.role`**. Startup changes that column's insertion default to `viewer` for both existing and newly created login databases; it does not rewrite existing records. No new tables or environment settings are needed. Explicit Discord-login insertion also selects Viewer for new pending accounts after admin bootstrap.

Deploy the backend and updated web assets, restart the backend, and update desktop clients. Authenticated bot operations retain their independent authorization. No Google Apps Script changes are required.
