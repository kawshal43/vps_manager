# Validation record

Date: 20 November 2026 (Asia/Colombo).

## Unreleased — Websites & Deployments

Implemented on `kawshal/Buildfeatures`, keeping application version 0.3.2 and developer credits unchanged. The new app reuses the existing desktop, SSH/SFTP connection and native confirmation paths. Supported managed updates are existing selected-service Docker Compose projects and dedicated prebuilt static roots. Standalone runtime adapters, migrations, database/media restoration, automatic certificate/DNS changes and automatic rollback are not implemented; see [the supported scope, security limits and complete file map](websites-deployments.md).

| Check                         | Observed result                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`               | Passed ESLint, tests, strict TypeScript and production build                                                                                                                                                                                                                                                                                               |
| Unit suite                    | 152 passed; 1 external Ubuntu entry skipped                                                                                                                                                                                                                                                                                                                |
| New website tests             | 59 passed: parser/discovery/policies, source manifests/ZIP safety, Compose command scoping, real manager/copy/hash lifecycle against an in-memory SSH/SFTP fixture, static/image backup and restore, failures, disconnection/cancellation, drift, permissions, protected data, isolated Git revision fixtures, metadata/log bounds and UTF-8/output limits |
| Source Electron suite         | 9 passed; two disposable-server workflows and packaged-only startup skipped                                                                                                                                                                                                                                                                                |
| Packaged suite invocation     | 10 passed; two disposable-server workflows skipped. Development and Windows-origin tests retain their own source fixtures; the remaining eligible tests use the packaged executable.                                                                                                                                                                       |
| Website UI                    | Import, automatic/manual health, Files navigation with previous selection cleared, blocked preview, acknowledgement, deployment/history, explicit restore, failed-job recovery, minimize/restore, server switching, 560px internal window and dark theme passed                                                                                            |
| Native website IPC            | Invalid and unauthenticated requests rejected; corrupt feature metadata preserved without preventing normal desktop startup                                                                                                                                                                                                                                |
| Regression coverage           | Existing clipboard, file drops, editor drafts, terminal lifetime, window/layout isolation, development bridge, Windows origin paths, packaged startup/reload and cancelled native close passed                                                                                                                                                             |
| Formatting / dependency audit | Prettier passed; `npm audit` reported zero vulnerabilities                                                                                                                                                                                                                                                                                                 |
| Local Windows packaging       | `npm run pack` and final `electron-builder --dir` completed; unpacked executable at `dist/win-unpacked/VPS Manager.exe`                                                                                                                                                                                                                                    |

Screenshots were inspected at `test-results/websites-deployments.png`, `websites-compact.png` and `websites-dark.png`. The previous 0.3.2 NSIS installer is not a new feature release; build a new installer deliberately with `npm run dist:win` if needed. No release or artifact was published to GitHub.

The deployment test transport is an explicit local fixture, not a live Ubuntu server. The illustrative A Plus TV test verifies selected `web`/`api` command scope, preserved PostgreSQL/media configuration and omission of Nginx/other-site service actions without connecting to the supplied host. No saved production credentials or live VPS were used. Actual Linux/Docker builds, hosting permissions, TLS/public network behavior, application business logic and production recovery still require an explicitly authorized disposable-host qualification. Older validation entries below are historical rather than new live-server runs.

## 0.3.2 — Terminal clipboard

TypeScript, ESLint, Prettier and the production build passed. Unit tests: 93 passed, with the external Ubuntu entry skipped. The source Electron suite passed 7 tests; the two disposable-server workflows and the packaged-only startup test were skipped in that invocation. Three focused tests then passed against the packaged Windows application: native clipboard IPC/text-field menu roles, packaged startup/reload/version, and terminal clipboard interaction.

The clipboard checks cover real mouse selection and right-click copy/paste, Ctrl+Shift+C/V, Ctrl+C with and without selection, Ctrl+Insert, Shift+Insert, empty clipboard, multiline/bracketed paste, and a Unicode code block larger than the 64 KiB IPC request limit followed by typed input. Files' Copy full path and copying from the built-in editor into the terminal passed. Clipboard tests preserve and restore all available clipboard formats. SSH input/output is an explicit offline fixture; no server was accessed for this change. Text-field native menu roles are inspected without opening an OS popup in the automated test.

Windows x64 NSIS packaging completed successfully: `dist/VPS-Manager-0.3.2-x64-Setup.exe` (unsigned).

## 0.3.1 — Developer credits

Added Nuranova Solutions and developers Kawshal, Shanal and Shehan to Settings → About VPS Manager and the connection footer. TypeScript, ESLint, Prettier and the production build passed. The source and packaged Electron application were visually checked with isolated local data, confirming all credits and the running 0.3.1 version. Windows executable metadata was inspected: CompanyName is Nuranova Solutions, LegalCopyright is Copyright © 2026 Nuranova Solutions, and ProductVersion is 0.3.1.0.

The Windows x64 NSIS installer was rebuilt as `dist/VPS-Manager-0.3.1-x64-Setup.exe` and remains unsigned. Screenshots are `.test-data/credits-about.png` and `.test-data/credits-connection.png`. This change did not access a server; the 0.3.0 integration results below are historical, not a new run for this credits update.

## 0.3.0 — Desktop workspace

The Windows desktop now has a taskbar, searchable launcher, app pinning, per-server app windows, drag/resize/minimize/maximize, a combined Server app and independent editor windows. The existing SSH/SFTP services remain the operation owners. Desktop appearance uses a separately validated workspace.json; ordinary app layouts restore after login, while restored terminals remain dormant. Unsaved editor changes have both window-level and native application-close guards.

Final verification on Windows 10 x64 / Electron 45.2.3:

| Check                        | Observed result                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, ESLint, Prettier | Passed                                                                                                                                                                                                                                                                              |
| Unit tests                   | 93 passed; external Ubuntu unit entry skipped in the ordinary invocation                                                                                                                                                                                                            |
| Ubuntu acceptance            | All 21 checks passed against the existing disposable loopback fixture                                                                                                                                                                                                               |
| Packaged Electron suite      | All 8 tests passed, including actual Ubuntu files/editor/uploads/terminal/services, application filters/deployments, development bootstrap, Windows origin paths, packaged bootstrap/reload, native layout/close guards, multi-server window lifecycle and native-backed file drops |
| Desktop/explorer file drops  | Real disk-backed Files passed through preload, were uploaded over SFTP into the test-created directory, and were read back with matching content                                                                                                                                    |
| Window interaction           | Pointer movement/resizing, maximized/minimized restore, server switching, editor draft retention, dormant terminal restore, 560px compact windows and the 960×640 application minimum passed                                                                                        |
| Dependency audit             | Zero known vulnerabilities                                                                                                                                                                                                                                                          |
| Windows x64 NSIS installer   | Built successfully; NotSigned                                                                                                                                                                                                                                                       |
| Visual review                | Packaged desktop, launcher, compact/minimum layouts, actual remote files and PTY windows inspected                                                                                                                                                                                  |

Focused windows keep stable DOM nodes and use a separate stacking rank. The compact-window regression checks that resizing and switching servers still allow a file double-click to open an editor, without moving the file grid during the pointer sequence. Native layout tests use the real IPC/persistence path and reject unexpected fields; presentation fixtures use two explicitly artificial servers and do not claim live server data. Native dialog answers are supplied by the test harness. File drops use Chromium disk-backed File objects and synthetic drop events; physical Windows drag gestures, high DPI, screen readers, Windows 11 and prolonged/very large transfers still need manual qualification.

All server changes were confined to disposable fixture files/deployments. Tests cleaned up their directories and isolated application data. The fixture VM was shut down after verification. No production server was accessed for this release.

Installer: `dist/VPS-Manager-0.3.0-x64-Setup.exe`, 128,100,510 bytes, Authenticode **NotSigned**.

```text
SHA-256: 0e34e6c98b5ef5531bc81d261b1e121e428c0d2baa704fba8723b39aa07496af
```

Screenshots: `test-results/desktop-workspace.png`, `desktop-launcher.png`, `desktop-compact-window.png`, `desktop-960.png`, `files.png` and `terminal.png`.

## 0.2.0 — Application inventory and removal

The new Applications view was checked against real Ubuntu package metadata and deployment directories. Production validation was read-only: the authorized Ubuntu 26.04 server returned 1,106 installed packages, 50 manually marked packages, 856 with optional priority and 277 protected by app policy. The `xrdp` APT dry run proposed only `xrdp`; SSH package removal was blocked. The real Electron interface displayed the inventory, search/filter results, removal preview and deployment registration form using isolated temporary user data. No production uninstall, deployment registration, service change or sudo command was executed.

On the disposable Ubuntu 24.04.5 fixture, all 11 application-management acceptance checks passed. These covered installed metadata/core protection, protected removal denial, session-bound tokens, no implicit elevation, cancellation at the actual APT prompt, real `hello` removal with explicit sudo, package restoration, saved-entry-only removal, stale deployment rejection, actual deployment deletion and linked-service stop/disable while retaining its unit definition. Temporary remote directories and local test data were removed. Fixture-only sudo authorization was never installed on the production server.

Final release checks:

| Check                                 | Observed result                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict TypeScript and ESLint          | Passed                                                                                                                                              |
| Prettier                              | Passed                                                                                                                                              |
| Unit tests                            | 88 passed; external Ubuntu test skipped in the ordinary unit invocation                                                                             |
| Actual application-removal acceptance | 11 checks passed on the disposable fixture                                                                                                          |
| Source Applications desktop workflow  | Passed with actual SSH/SFTP                                                                                                                         |
| Packaged Electron regression suite    | 5 passed: Applications, complete files/editor/upload/terminal workflow, development bootstrap, Windows URL/path handling, packaged bootstrap/reload |
| Full npm audit                        | Zero known vulnerabilities                                                                                                                          |
| Windows x64 NSIS build                | Built; unsigned                                                                                                                                     |
| Visual review                         | Actual package table, removal modal, registration form and deployment card inspected                                                                |

The complete desktop workflow initially expected the sleep-only fixture service to remain loaded after removal testing. That assertion failed because the preceding test deliberately stopped/disabled it. The discovery check now uses the real `ssh.service`; the separate fixture restart-denial check is unchanged. The failed run's exact test directory was removed, failure cleanup was added, and the complete packaged suite passed afterward.

Settings migration tests verify that version 1 profiles, trust history and credential ciphertext survive migration to version 2. Package proposal parsing, dependency protection, malicious identifiers, changed snapshots, foreign/expired tokens, native cancellation and approval only after an exact transaction match have dedicated unit coverage.

Installer: `dist/VPS-Manager-0.2.0-x64-Setup.exe`, 128,089,810 bytes. Authenticode: **NotSigned**.

```text
SHA-256: def8e2767b61b0a3155e17d952955f79e997a05b6c5794a32dae749e642a71ea
```

Screenshots: `.test-data/application-inventory.png`, `application-removal-preview.png`, `deployment-registration.png` and `deployment-card.png`. Native confirmation answers were supplied by the desktop harness; physical native-dialog interaction, Windows 11, publisher signing, long-running/large-tree removal behavior and an independent security review remain unqualified. Dedicated Snap/Docker/pip/npm inventories are outside this release.

## 0.1.2 — Authorized live-server verification

The app’s adapters passed 14 bounded checks on the user-authorized Ubuntu 26.04 server, including checksum-verified streaming transfers, file edits and conflict protection, monitoring, read-only service discovery, and PTY operation. Temporary remote and local files were cleaned up. A late-acknowledgement lifecycle race was corrected and covered by a new unit test; 59 unit tests passed. See [the full live-server record](live-server-validation.md) for the observed results and native-window testing limits. No production services or existing user files were changed.

## 0.1.1 — Startup IPC correction

Reproduced the reported “IPC request origin was rejected” failure by supplying the slashless renderer URL emitted by electron-vite. Version 0.1.0 rejected bootstrap and left Connect disabled because Chromium added a trailing `/`. Version 0.1.1 uses the same canonical URL for loading and IPC validation, retaining the existing window, main-frame and exact-document checks.

Patch verification: strict typecheck, lint, build and formatting passed; 58 unit tests passed. The development startup/reload regression and a Windows path regression (spaces, Unicode, URL punctuation) passed. The rebuilt packaged application also passed bootstrap, enabled-Connect and reload checks. SSH/SFTP code was unchanged; the full Ubuntu workflow results below are from the original release qualification, not a new run for this patch.

Updated installer: `dist/VPS-Manager-0.1.1-x64-Setup.exe` (unsigned).

```text
SHA-256: 8ec5f01deb3808b8e5528227452608481aa46e8ccdb0c8a554fcb23fa7fa1ccb
```

The remaining sections record the original 0.1.0 validation.

## Environment

- Windows 10 x64, build 19045.6466.
- Node.js 24.14.1, npm 11.11.0, TypeScript 6.0.3.
- Electron 45.2.3, electron-vite 6.0.0, Vite 8.3.6, electron-builder 26.18.0.
- A newly provisioned VirtualBox Ubuntu Server 24.04.5 LTS instance with OpenSSH/SFTP, an unprivileged test account, independently generated host key and loopback-only SSH forwarding.
- No operations were executed on the user’s OVH server or the pre-existing VirtualBox VM.

## Recorded checks

| Check                         | Observed result                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| TypeScript strict type check  | Passed                                                                                                |
| ESLint, zero warnings allowed | Passed                                                                                                |
| Prettier check                | Passed                                                                                                |
| Unit suite                    | 50 tests passed                                                                                       |
| Real Ubuntu integration suite | 21 scenario checks passed; full Vitest run: 51 tests passed in 3 files, no skips                      |
| Source desktop workflow       | Passed against real Ubuntu                                                                            |
| Installed desktop workflow    | Passed against real Ubuntu, including Windows secure-storage credential reuse and profile restoration |
| Development renderer startup  | Passed with the real Electron bridge and a loopback Vite server                                       |
| Full npm dependency audit     | Zero known vulnerabilities reported                                                                   |
| Windows x64 NSIS package      | Built successfully with the application icon                                                          |
| Silent installer smoke test   | Exit code 0; installed executable was launched and tested                                             |
| Silent uninstaller smoke test | Exit code 0; isolated installed executable removed                                                    |
| Test fixture cleanup          | Leftover test directory removed; disposable VM shut down normally                                     |

The install/uninstall tests used `.test-data/installed`, not a normal production installation. The packaged application used separate temporary user data during testing. Native file-picker and file-action confirmation values were supplied by the E2E harness; no native-dialog layout or assistive-technology qualification is implied.

Installer: `dist/VPS-Manager-0.1.0-x64-Setup.exe`, 128,083,355 bytes. Authenticode status: **NotSigned**.

SHA-256:

```text
48fb181f05a8bb94fabce64da84f44fb3263db5f6f4a2c03621e907eb6efa01d
```

Screenshots from Electron are written to `test-results/connection-screen.png`, `overview.png`, `files.png` and `terminal.png`. These show actual local fixture data. They are ignored build/test artifacts, not production assets or hardcoded screen content.

The local source desktop workflow completed in approximately five seconds on this host; the installed application workflow completed in approximately eight seconds including the test harness. It transfers a small folder and edits a small file; this is not evidence of large-file throughput or long-running reliability. The SSH/SFTP suite additionally transfers and verifies a 4 MiB nested file, interrupts active uploads, disconnects a transport mid-replacement and checks that the original target is preserved.

## Unverified scope

Windows 11, other Ubuntu LTS versions, multi-GiB throughput, 10,000-entry performance benchmarks, prolonged sessions, screen reader qualification, publisher signing and an independent security review remain release gates. Native dialogs are supplied deterministic responses by the E2E harness; physical picker interaction and all native-dialog layouts require manual qualification.
