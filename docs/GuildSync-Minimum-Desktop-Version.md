# Minimum supported desktop version

Set these optional values in **NodeJS/GuildSync-Backend-Server/.env** and restart the backend:

```env
# Blank/unset keeps minimum-version enforcement disabled.
GUILDSYNC_MIN_DESKTOP_VERSION=

# Optional fallback when a compatible platform installer is not available locally.
GUILDSYNC_DESKTOP_UPDATE_URL=https://github.com/skperdue68/GuildSync/releases/latest
```

Set the minimum to a published desktop release, for example `1.5.0` (no leading `v`). Version comparison is numeric, including prerelease ordering; `1.10.0` is newer than `1.9.0` and `1.5.0-beta.1` is older than `1.5.0`.
Invalid configuration fails startup with a configuration error. There is no administrator-screen override for these settings.

The server checks desktop compatibility before registering application handlers, subscribing the socket to data broadcasts, or sending account/admin notifications. Older clients without handshake metadata must report their version first; otherwise they are disconnected after 15 seconds. Web clients, the authenticated Discord bot, and standalone voice clients are outside this desktop policy.

A supported but outdated desktop may continue working and retain the existing optional update prompt. A desktop below the minimum is sent an unsupported-version message, minimum version, and upgrade link, then disconnected.
The link uses the server's existing installer lookup for that platform when its version satisfies the minimum. A locally available installer below the minimum is never offered as the solution; the configured fallback is used instead. Publish compatible installers before raising the minimum.

The updated desktop stops reconnection, polling, queued server requests, file watching, and voice hotkeys when rejected. It removes the roster, banking, history, profile and other GuildSync views and shows only the upgrade screen, download button, and window controls.
Queued local banking/mail upload records are preserved, not deleted. In-flight work already started before rejection is not undone.
Rejection is terminal for that running desktop process; restarting performs a fresh version check. Installing a supported release restores normal access after restart.

## Rollout order and older binaries

1. Publish and distribute a desktop release containing the new rejection-screen handling, together with the backend/web update. Leave the minimum blank initially.
2. Ensure the intended supported platform installers or fallback download page are available.
3. Set the minimum to that release (or a later compatible release) and restart the backend.

Already-installed older binaries cannot be retroactively given new UI code. The server still withholds new data from them and server-disconnects their socket (Socket.IO does not automatically reconnect after a server disconnect). Their existing update handler may show only its older update prompt, and the server cannot reliably erase data already displayed by those older binaries. The complete clear-screen and stop-all-activity behavior requires the updated desktop code.

Version/client-type declarations are a compatibility mechanism, not cryptographic proof of a binary's identity; normal account authorization continues to protect data. Do not use this setting as a replacement for access controls.

No database migration, ESO addon, Discord bot, or Google Apps Script update is required. Rebuild/deploy the web client as well so it identifies itself explicitly at connection time; older web clients remain compatible through their existing version report.
