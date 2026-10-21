# GuildSync desktop client

The Wails desktop client authenticates through Discord, displays GuildSync data, watches ESO SavedVariables exports, and safely writes queued ESO receipt mail when the game is closed. It shares administration concepts with the server-backed browser interface.

- [Everyday user guide and Discord/ESO commands](../../docs/GuildSync-User-Guide.md)
- [Detailed workflows, configuration, and troubleshooting](../../docs/GuildSync-Detailed-Help.md)
- [Release packaging and deployment](../../docs/GuildSync-1.2.7.md)

## Development and builds

Run `wails dev` here for desktop development with the Vite frontend. Run `wails build` for a desktop build. The frontend lives in `frontend`; install its locked dependencies with `npm ci` and build using `npm run build` as described in the release guide. Platform installers are prepared through the repository packaging/release workflow.

Generated `frontend/dist`, `frontend/wailsjs`, `frontend/package.json.md5`, `build/bin`, and `release` files are not committed. The empty `frontend/dist/.gitkeep` lets Go's embed directive compile before the first build; `frontend/public/.gitkeep` preserves it when Vite recreates the output directory. On a fresh checkout use `wails dev` or `wails build` to regenerate the Go/JavaScript bindings and frontend output. A standalone frontend build needs the bindings first (`wails generate module` from this directory). Direct Go tests can use the placeholder, but runnable desktop applications require the real frontend build. Keep `build` icons, platform manifests and installer templates: those are source inputs, not compiled output.

## Local settings

### Voice Channel Mute (Windows)

Open your profile menu and enable **Voice Channel Mute**. Hold **Ctrl+M** to request a temporary server mute for eligible lower-ranked members of your current Discord voice channel. Release the keys to end it. Your server must enable the feature and allow your Discord role; server owners, peers, higher ranks, bots, and moderator mutes are protected.

**Set Hotkey** captures Ctrl, Alt, or Shift plus a letter, number, or F1–F12. Escape cancels capture. The feature starts disabled; personal settings are saved in the operating system user configuration directory under `GuildSync/voice-hotkey.json`, independently on each computer. Changing settings or capturing a shortcut ends an active session.

Global hotkeys are supported by the Windows desktop client. Browser, macOS, and Linux clients display an unsupported notice. A separately distributable companion is a follow-up.

Logout, disconnection, and exit release the session. While held, the desktop sends authenticated heartbeats every two seconds; the server expires a lost release after eight seconds. Reconnecting while holding the shortcut does not start a new session: release and press again. Recovery may take longer if Discord cleanup fails. Discord exposes a single server-mute flag, so a moderator reapplying mute to someone already temporarily muted may be unobservable; ambiguous mutes are preserved for review.

Packaged defaults normally suffice. `.env` and `GuildSyncSettings.txt` can override local SavedVariables paths and backend connection settings. The profile's Banking/Roster/Applications watcher switches persist independently. Do not put server secrets in desktop configuration. See the [desktop environment table](../../docs/GuildSync-Detailed-Help.md#desktop-optional-local-overrides).

ESO saves add-on data to disk at reload/logout/exit. Writing a receipt mail batch requires ESO to be fully closed; the queue sends on the next Banking add-on load. Backups are kept under SavedVariables/GuildSyncBackups before cleanup/queue edits.
