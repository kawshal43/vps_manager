# Release notes

## Unreleased — Websites & Deployments

Feature branch `kawshal/Buildfeatures` adds an integrated Websites desktop app with Nginx/Compose discovery, manual import, per-server state, details, source-update previews, selected-service Compose builds, versioned static publication, SHA-256 transfer checks, application snapshots, image retention, deployment progress/logs, health/routing verification and confirmed application restore. Sources include native Windows folders/ZIP archives, remote directories, isolated exact-commit Git checkouts and current-source rebuilds. Existing Files/Terminal windows and native confirmation/security boundaries are reused.

The feature blocks ambiguous/shared roots, protected data services, source bind mounts, infrastructure changes and migration indicators. Other standalone runtimes and Apache/Caddy support are inspection/manual import only. Database/media backups or restoration, automatic rollback, retention/deletion jobs, certificates/DNS/Cloudflare changes and zero-downtime guarantees are not provided. No production VPS was accessed. See [the deployment guide](websites-deployments.md) and the validation record. The existing application version and developer credits are unchanged.

## 0.3.2 — Terminal clipboard

Terminal right-click copies selected text to the system clipboard and clears the selection; right-click without a selection pastes. Ctrl+Shift+C/V, Ctrl+C with a selection, Ctrl+V, Ctrl+Insert and Shift+Insert use the native clipboard. Ctrl+C without a selection continues to interrupt the running command. Paste respects terminal newline and bracketed-paste modes, and input is split into ordered requests for code longer than one IPC message.

Text fields and editors now have native right-click editing menus. Files' Copy full path action also uses the native clipboard. Browser permission restrictions remain in place; clipboard operations use the existing validated desktop bridge. Installer: `dist/VPS-Manager-0.3.2-x64-Setup.exe` (unsigned).

## 0.3.1 — Developer credits

Added Nuranova Solutions and developers Kawshal, Shanal and Shehan to Settings → About VPS Manager and the connection-screen footer. The About panel shows the running application version. Package author/contributor metadata and Windows company/copyright details now identify the development team. Installer: `dist/VPS-Manager-0.3.1-x64-Setup.exe` (unsigned).

## 0.3.0 — Desktop workspace

The server workspace now opens onto a restrained desktop with Files, Terminal and Server shortcuts, a taskbar, searchable launcher and independent movable/resizable app windows. Server groups overview, services, monitoring and logs. Applications and Settings are available in the launcher; apps can be pinned or unpinned. Editors open as separate windows and retain local drafts while minimized, switched away or disconnected. Closing the application with dirty editors requires native confirmation.

Local files and folders can be dropped onto the desktop to choose an upload folder, or into Files to target its current folder. Both use the existing streaming transfer queue, conflict handling and permissions. Desktop uploads can create the account's conventional home Uploads folder after submission; other destination folders must already exist. Transfer activity remains accessible from the taskbar.

Window layouts and pins use a separate workspace.json, preserving existing settings, profiles, trust history and encrypted credentials. Restored terminal windows remain minimized until explicitly opened. Transfers and shell commands are never replayed after restart. Keyboard access includes Ctrl+K for the launcher, Ctrl+F6 to cycle windows, Ctrl+Alt+D to show the desktop, and Ctrl+Arrow / Ctrl+Shift+Arrow on a focused internal title bar to move / resize its window.

This release targets the Windows desktop. The installer remains unsigned. See the validation record for automated Electron, disposable Ubuntu and visual checks and remaining manual release gates.

## 0.2.0 — Package filters and registered deployments

Applications now has Ubuntu packages, My deployments and Processes & ports tabs. Installed APT/dpkg packages can be searched and filtered by manual mark, automatic dependency or optional priority. The interface explains that optional/manual metadata does not establish that software is unused. Protected components remain visible on request with uninstall disabled.

Uninstall shows the exact APT dependency proposal, revalidates package state and checks the actual transaction before final native confirmation. Current-account authorization is the default; existing noninteractive sudo authorization must be explicitly selected for each operation. There is no purge, autoremove, automatic yes, stored sudo password or production authorization change.

Manually deployed apps can be registered by installation directory with an optional systemd service. Removing a saved entry preserves server files. Confirmed file removal previews and revalidates a bounded directory tree, stops/disables any linked noncritical service and deletes using SFTP permissions. The systemd unit definition and data outside the registered directory are retained. Dedicated automatic Snap, Docker, pip and npm inventories are not included.

Settings version 2 adds deployment metadata and preserves version 1 profiles, trusted hosts and credential ciphertext. Close the old app before upgrading; older releases cannot read the migrated format. Keep a private pre-upgrade settings backup if rollback is required.

Validation includes unit policy/authorization tests, actual APT cancellation/removal and deployment deletion on a disposable Ubuntu fixture, and read-only inventory/preview checks on the authorized Ubuntu 26.04 server. No software was uninstalled from the production server. See [validation](validation.md) for the final release checks. Installer: `dist/VPS-Manager-0.2.0-x64-Setup.exe` (unsigned).

## 0.1.2 — Terminal close lifecycle and live-server checks

Close a terminal using the SSH channel close operation without sending an `exit` command to a foreground application. Ignore output acknowledgements that arrive after the tab has already closed. A synchronous acknowledgement in the live-test harness exposed this race: the acknowledgement exception propagated through the SSH data callback and reset the harness connection. The updated handler, regression test and live-server rerun verify that SFTP continues working after terminal closure.

Added an explicitly invoked, bounded server smoke test using the app’s actual application/infrastructure adapters. It requires a saved profile and previously trusted host key, accepts a password through hidden stdin, and never writes credentials to a file or command-line arguments. Writes and cleanup are confined to a fresh UUID-named folder beneath the authenticated home directory. It performs no service changes, package installation, privilege elevation, process termination or network-configuration changes.

The live Ubuntu 26.04 LTS server passed 14 checks, including a 1 MiB recursive upload/download with a matching SHA-256 digest, atomic editing, stale-edit rejection, copy/move/rename/permissions on test files, monitoring, read-only service/process/port/log inspection and PTY use. Remote and local test data were removed. The native Windows capture helper timed out, so this live verification covers backend integration rather than full visual/native-dialog qualification.

## 0.1.1 — Fix development startup IPC rejection

Normalize the renderer URL before both loading it and registering its IPC origin. electron-vite supplies a bare HTTP origin without a trailing slash; Chromium canonicalizes it with `/`. Version 0.1.0 compared those strings literally and rejected the app’s own bootstrap requests when started by the development CLI, leaving Connect disabled.

The same main-window, frame and exact-document checks remain enforced. New regression coverage uses electron-vite’s slashless URL, checks successful bootstrap and an enabled Connect button before and after reload, and verifies that other origins, documents, windows and child frames remain rejected. A separate desktop regression checks Windows paths containing spaces, Unicode and URL punctuation.

## 0.1.0 — Initial release candidate

## Included

Secure Electron/React/TypeScript foundation; validated IPC; real SSH/password/key authentication; explicit host-key trust; profile storage; async OS-backed credential storage; SFTP explorer and file operations; streamed folder/file transfers; safe replacement; UTF-8 CodeMirror editor; multi-tab SSH PTY terminal; live resource monitoring; systemd details/actions/logs; process and port inspection; settings; Windows x64 NSIS packaging; automated policy, Ubuntu integration and desktop workflow tests.

No production workflow uses fabricated files, metrics, services or successful-operation results. Native confirmations precede destructive operations. No GUI sudo or root-elevation fallback is implemented.

## Deliberate limits

- Pause/resume and automatic reconnect/replay are unavailable. Retry starts over. Transfer history is in memory.
- Cross-filesystem move has no automatic copy/delete fallback. Existing-file atomic replacement requires OpenSSH’s rename extension.
- Folder downloads reject symlinks and invalid Windows names. Uploads reject local symlinks/junctions. Text editing is UTF-8 and limited to 2 MiB.
- Source/destination attributes and byte counts are checked; general large-file checksum negotiation is not implemented.
- Service privileges are whatever the server already grants. Successful privileged service modifications require qualification in an appropriately authorized disposable environment.
- File settings currently cover theme, hidden files, concurrency, monitoring interval, window size, last profile and last directory. User-defined shortcuts, notifications, and other advanced preference customization remain future work.
- At 0.1.0, deployment profiles and package management were deferred; version 0.2.0 adds APT package removal and registered directories. PostgreSQL/Nginx workflows and backup scheduling remain future work.

## Release gates

This candidate has passed the recorded Windows 10 / Ubuntu 24.04 validation in [validation.md](validation.md). It is not a claim of completed milestone 6 production qualification. Before broad distribution: sign binaries/installer with a publisher certificate; qualify Windows 11 and other supported Ubuntu/OpenSSH versions; complete long-running, very large file/directory, low-disk, crash-recovery, accessibility and high-DPI checks; conduct an independent security review.

## Reproduce packaging

```powershell
npm ci
npm run check
npm run test:ubuntu
npm run test:e2e
npm audit
npm run dist:win
```

`resources/icon.svg` is the code-native server mark. Run `python scripts/generate-icon.py` to regenerate PNG/ICO resources. Keep the lockfile with source changes and rerun validation after dependency upgrades. Configure electron-builder signing through its supported certificate environment variables in a protected release environment; never commit signing credentials.
