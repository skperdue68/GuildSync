# Automatic installer downloads

When a release is published, the platform builds attach the actual GuildSync-Setup-<version>-Windows.zip, -macOS.zip and -Linux-x86_64.zip assets. After all platform and server builds succeed, Publish installer ZIPs to downloads fetches those assets directly. It never publishes the GuildSync-installers-* Actions wrapper and keeps the installer ZIPs intact.

The job validates all three ZIPs and proposes them in a pull request under NodeJS/GuildSync-Backend-Server/public/downloads. Older installers remain tracked. For the most recently published release, the same pull request synchronizes VERSION, desktop/web version constants, packages/locks, Wails metadata, ESO versions, Windows installer fields and the backend .env.example. A rerun of an older release adds its installers without rolling source versions back. Rerunning after identical assets and versions have been merged needs no new commit. GitHub Actions needs contents and pull-requests write access, and repository Settings → Actions → General must allow Actions to create pull requests. The workflow never pushes directly to master. Installer builds run only for published releases, not these pull requests.

## Enable uploads to the running server

The publication pull request is opened automatically and must be reviewed and merged. Live uploads run independently of that merge and require a Linux/Unix server reachable through SSH from GitHub-hosted runners, Python 3.9 or newer, and a dedicated SSH account with write access to the downloads directory. No app restart is required to serve newly uploaded files.

In repository Settings → Secrets and variables → Actions, add these **secrets**:

| Secret | Value |
| --- | --- |
| GUILDSYNC_DEPLOY_HOST | Server hostname or IPv4 address |
| GUILDSYNC_DEPLOY_USER | SSH login account |
| GUILDSYNC_DEPLOY_SSH_KEY | Dedicated private key whose public key is authorized on the server |
| GUILDSYNC_DEPLOY_KNOWN_HOSTS | Verified known_hosts entry for the server; for a custom port use [hostname]:port format |

Verify the host key through your server provider or an existing trusted connection; the job enforces host-key verification.

Add these **repository variables**:

| Variable | Value |
| --- | --- |
| GUILDSYNC_DEPLOY_DOWNLOADS_ENABLED | true |
| GUILDSYNC_DEPLOY_DOWNLOADS_DIR | Absolute path to the directory the backend serves |
| GUILDSYNC_DEPLOY_PORT | SSH port; optional, defaults to 22 |

The default served directory is <server-repository-root>/NodeJS/GuildSync-Backend-Server/public/downloads. If the backend sets GUILDSYNC_DOWNLOADS_DIR, use that exact absolute directory instead. The backend environment value does not automatically become a GitHub Actions variable. Set the path for your actual deployment; do not use a Windows Downloads folder or guess the server root.

The job uploads only the three installer ZIPs and a temporary validation script. It validates the complete set before promoting files, replaces each file atomically, preserves older versions and removes its temporary SSH credentials and server staging folder when finished. It does not modify application code, secrets, database or persistent data. The backend offers installers for its own packaged version; publishing download files alone does not advance the running backend's version. Prerelease assets are retained alongside stable installers and likewise do not change which version the backend offers.

Without live-upload configuration, the job proposes the GitHub update and displays a warning that the server upload is disabled. With it enabled, missing settings or a failed upload cause the job to fail. Once configured, publish a release containing these workflow/tools changes and check the Publish installer ZIPs to downloads job. To repeat a failed copy, open Actions → Publish GuildSync downloads → Run workflow on master, enter the existing release tag (for example v1.3.6), and run it. This downloads already built release assets without rebuilding installers or publishing a new release. Use this manual workflow after a publication-code fix, because rerunning an older release build still uses its original workflow snapshot.

## After pulling a release

From the repository root, run:

```sh
git pull
go run tools/update-version.go
```

The updater reads the VERSION file after the publication pull request is merged. It also replaces GUILDSYNC_CLIENT_VERSION in an existing NodeJS/GuildSync-Backend-Server/.env while preserving other settings. That local ignored file cannot be updated by git pull itself; it is never committed or included in release ZIPs. Missing .env files are left missing. To select an explicit release, run go run tools/update-version.go v1.3.5. Compiled web files are intentionally untracked: after a source pull run npm ci and npm run build:web in NodeJS/GuildSync-Backend-Server, then restart through your normal service manager and refresh the browser. Alternatively deploy the compiled web files from GuildSync-Server-<version>.zip using tools/sync-release-web.py --bundle /path/to/GuildSync-Server-<version>.zip --version <version> from the repository root. This helper preserves downloads. A git pull supplies tracked installer ZIPs after their publication pull request is merged, but no longer supplies the web bundle. See Repository-Contents.md for fresh-checkout and migration notes.

## Local verification

Run python tools/sync-release-downloads.test.py. The helper also accepts downloaded Actions wrapper ZIPs and removes up to two wrapper layers without extracting the installer itself. For manual copying, run:

```sh
python3 tools/sync-release-downloads.py --source /path/to/downloaded-assets --destination /absolute/server/downloads --version v1.4.0
```




