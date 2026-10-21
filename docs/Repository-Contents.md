# Repository contents and generated files

The repository stores source code, tests, documentation, dependency lockfiles, example configuration, installer source inputs and the published installers in `public/downloads`. Other generated application files belong in local build/deployment directories and GitHub Releases.

## October 2026 audit

The cleanup stops tracking these paths:

| Path | Why it is excluded | How it is recreated |
| --- | --- | --- |
| `GO/GuildSync-Frontend-Client/frontend/dist/` compiled files | Compiled desktop HTML, JavaScript, CSS and copied images; only an empty `.gitkeep` stays tracked | `wails dev` / `wails build` |
| `GO/GuildSync-Frontend-Client/frontend/wailsjs/` | Generated Wails Go bindings and runtime wrappers | Wails startup/build, or `wails generate module` |
| `GO/GuildSync-Frontend-Client/frontend/package.json.md5` | Wails dependency-install checksum | Wails tooling |
| `NodeJS/GuildSync-Backend-Server/web/dist/` | Vite web build output | Backend `npm run build:web` |
| `NodeJS/GuildSync-Backend-Server/public/index.html` and `public/assets/` | Deployment copy of the web build | Backend `npm run build:web`, or server release bundle |
| `Installer/Linux/FyneInstaller/payload.tar.gz` | Generated embedded installer payload | `Installer/Linux/make-linux-fyne-appimage.sh` creates a temporary payload before compiling |

The audit found no tracked `.env`, service-account credentials, databases, `node_modules`, or application executables outside the installer archives. All 18 installer ZIPs in `public/downloads` stay tracked at the owner's request. The blank `GuildSyncSettings.txt` is an intentional distributable settings template and stays tracked. Wails icons, platform manifests, NSIS/Inno scripts, source images, SQL migrations, package lockfiles and documentation also stay tracked. Do not delete the entire desktop `build` directory: it contains source inputs.

`.gitignore` now covers the actual desktop paths (the old rules named obsolete directories), generated server web assets, local worktrees, credential filenames, runtime data and Python caches. Downloads remain trackable. Ignore rules do not remove anything from previous commits.

## Fresh source checkout

For the backend/web client:

```sh
cd NodeJS/GuildSync-Backend-Server
npm ci
npm run build:web
# Configure your ignored .env, then start using your existing service manager.
```

Run the web build before `node --test`; the existing bundle test verifies the actual files served by the backend. Rebuild after pulling web source changes. A source checkout alone no longer contains a runnable web UI.

For the desktop, install Go, Node and the project-supported Wails CLI/platform dependencies, then run `wails dev` or `wails build` in `GO/GuildSync-Frontend-Client`. For a standalone frontend build, first run `wails generate module`, then `npm ci` and `npm run build` in `frontend`. The tracked empty `frontend/dist/.gitkeep` satisfies Go's embed directive before the first build; its source copy in `frontend/public/.gitkeep` preserves it across Vite builds. A usable desktop app still requires actual generated frontend output.

For packaged server deployments, use `GuildSync-Server-<version>.zip` from the matching GitHub Release: it still contains freshly compiled web assets. See the release guide for preserving local configuration and installing backend/bot dependencies.

## Existing installations and downloads

When pulling this cleanup into a live source checkout, Git removes the previously tracked compiled web files even though the paths become ignored. Rebuild the web client before restarting, or deploy the matching server release bundle. Modified tracked generated files may require resolving local changes before pulling. Installer downloads, personal settings, database contents and secrets are not removed by this cleanup.

Installers remain both GitHub Release assets and tracked files in `NodeJS/GuildSync-Backend-Server/public/downloads`. After merging an installer-publication pull request, a Git pull supplies those ZIPs. Optional SSH publication can also populate a running server's downloads directory. Configure automatic uploads as described in [Automatic installer downloads](GuildSync-Automatic-Downloads.md).

Installer publication and source version synchronization are proposed through an automated pull request. Repository Actions must have permission to create pull requests. Compiled web assets are excluded from that branch, and the workflow does not push to master.

This cleanup changes the current repository tree only. Historical commits still contain the older build artifacts; no history rewrite, release deletion, or production deployment is performed.
