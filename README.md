# VPS Manager

A Windows desktop workspace for Ubuntu servers, built with Electron, React, TypeScript, ssh2, and SFTP. All server views and actions use the authenticated SSH connection. No management agent or Ubuntu desktop is required.

Developed by **Nuranova Solutions** — **Kawshal, Shanal and Shehan**. Developer credits and the running version are available in Settings → About VPS Manager.

Version 0.3.0 adds a desktop workspace with a taskbar, launcher, movable/resizable app windows and desktop uploads. Files, terminals and editor drafts stay in their server workspace when switching servers. Ubuntu package management and registered deployments remain available through the launcher. See [validation](docs/validation.md) for the environments actually tested and [release notes](docs/release.md) for remaining release gates.

The `kawshal/Buildfeatures` branch adds **Websites & Deployments**: read-only Nginx/Compose discovery, website import, source-update previews, selected-service Compose builds, static releases, application backups, health checks, logs and explicit restore. Standalone runtime adapters, migrations and database/media backup or restore are not implemented. Read the [supported scope and deployment guide](docs/websites-deployments.md) before using it. This feature is unreleased; the version remains 0.3.2.

## Run

Requires Windows 10/11 x64 and Node.js 22.12+ (development was verified with Node 24.14.1).

```powershell
npm ci
npm run dev
```

To run a production build:

```powershell
npm run build
npm start
```

The launch script removes `ELECTRON_RUN_AS_NODE` from the desktop child’s environment, which also supports development from hosts that set it for their own helpers.

## Windows package

```powershell
npm run dist:win
```

Output: `dist/VPS-Manager-0.3.2-x64-Setup.exe`. An unpacked application is available at `dist/win-unpacked/VPS Manager.exe`. This build is unsigned; public distribution requires a publisher signing certificate.

If version 0.1.0 shows “IPC request origin was rejected” during `npm run dev`, restart the development process after updating. Version 0.1.1 fixes the development URL normalization that blocked the desktop bridge before SSH authentication.

## Available workflows

- Desktop shortcuts, pinned/running taskbar apps, searchable launcher, independent server workspaces, minimize/maximize/restore, keyboard window movement/resizing and a Show desktop control. Layout is saved separately from credentials; restored terminal windows wait for explicit opening before starting a new shell.
- Drop local files/folders onto the desktop to choose a destination, or into Files to upload to its current folder. The conventional home `Uploads` folder is created only after submitting a desktop upload; other destinations must exist.
- Password and OpenSSH private-key authentication, key passphrases, first-use SHA-256 host verification, changed-key rejection, saved profiles, and opt-in OS-encrypted credentials.
- Multiple authenticated server sessions with separate files, terminal tabs, and transfer jobs.
- Real SFTP explorer: navigation history, breadcrumbs, address entry, hidden files, sorting, filtering, virtualized list/grid views, selection, context menus, properties, and Unix permissions.
- File/folder uploads and downloads, drag and drop, two concurrent transfers by default, progress/speed/ETA, cancellation, explicit retry, and conflict choices.
- Create, rename, copy, move, and confirmed permanent deletion. Copy uses a staging path before publishing the result. Protected system locations are blocked by GUI operations.
- UTF-8 editor with syntax highlighting, line numbers, search/replace, wrap, read-only mode, Save As, external-change checks, and atomic saves on capable servers.
- Interactive PTY terminals with tabs, resizing, search, bounded output buffering, and Open Terminal Here. Select text and right-click to copy; right-click without a selection to paste from any app. Ctrl+Shift+C/V, Ctrl+V and Shift+Insert are also supported; Ctrl+C interrupts when no text is selected.
- CPU, memory, swap, root-disk, uptime and load monitoring; real systemd discovery, service details/actions, journal logs, process inspection, listening ports, and confirmed SIGTERM requests.
- Applications: searchable installed APT/dpkg packages with manual, automatic and optional-priority filters, dependency previews and confirmed uninstall. Register manually deployed app directories, optionally link a systemd service, remove only a saved entry, or confirm permanent deployment-file removal.
- Theme, concurrency and monitoring preferences; trusted-host inspection; credential deletion; sanitized local diagnostics.
- Websites & Deployments in the launcher: independent server windows, native folder/ZIP sources, isolated exact-commit Git checkouts, full/partial/rebuild updates, SHA-256 staging verification, application history and restoration points. Persistent data and shared infrastructure are excluded from ordinary updates; unsupported or ambiguous deployments are blocked.

Package removal uses the current account or explicitly chosen existing noninteractive sudo authorization. It blocks protected system components and does not purge or autoremove. Manual deployments must be registered by installation directory; Snap, Docker, pip and npm inventories are not automatically discovered. Read [Applications usage](docs/operations.md#applications) and the [removal authorization design](docs/application-removal-security.md).

Close the old application before upgrading. Settings migrate to version 2 while preserving profiles, trusted hosts and encrypted credentials. Older releases cannot read the new format; retain a private settings backup if you need to roll back.

## Checks

```powershell
npm run check
npm run format:check
npm audit
```

`npm test` runs unit tests and skips the external Ubuntu suite unless a disposable test configuration is explicitly supplied. It never guesses a server or uses a production profile.

For the real Ubuntu and Electron tests, follow [testing](docs/testing.md):

```powershell
npm run test:ubuntu
npm run build
npm run test:e2e
```

The [live-server validation record](docs/live-server-validation.md) documents the explicitly authorized Ubuntu 26.04 smoke test and its terminal lifecycle finding. A separate `scripts/run-server-smoke.ts` runner accepts a password only through hidden stdin and requires a saved, already trusted server profile; it is never invoked by the ordinary test suite.

Read [operations](docs/operations.md), [security](docs/security.md), and [architecture](docs/architecture.md) before extending administration features.
