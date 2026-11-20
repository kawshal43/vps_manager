# Live server validation — 6 November 2026

## Extended follow-up — 18:26 Asia/Colombo

At the user’s request, the supplied credentials were used again against the same previously trusted server. The extended run completed from 18:26:03 to 18:26:45 Asia/Colombo: **26 checks passed**, no reported errors or limitations, and both remote and local cleanup were verified. This repeats the original 14 checks and adds the following 12 cases:

1. Unicode, apostrophes and shell punctuation remain literal filename data during creation and copying.
2. UTF-8 BOM and CRLF text are preserved.
3. Content-hash conflict detection rejects stale edits even after restoring the same file size and timestamp.
4. A permission-denied read on a test-created file fails without elevation; permissions are restored afterward.
5. Skip leaves an existing test-created target unchanged.
6. Keep both creates a distinct file and preserves the original.
7. Replace updates only the explicitly selected test-created file.
8. Cancelling an active replacement preserves the original target and removes partial data.
9. Explicit retry completes; the 4 MiB download matches the source SHA-256 digest.
10. The text editor rejects an oversized binary file before loading it.
11. Invalid Windows filenames are rejected before queuing a download, with no silent renaming.
12. Five PTY open/input/resize/close cycles leave the shared SFTP connection usable.

The server reported 217 systemd services and no failed units. No existing user files, services or configuration were changed. This run used the app’s backend adapters; live native-window capture still timed out after resetting the capture helper. No additional application defect was found. The test script changes passed strict TypeScript and lint checks; production application code and the v0.1.2 installer were unchanged by this follow-up.

To explicitly repeat the extended mode:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/run-server-smoke.ts HOST_ALREADY_SAVED_AND_TRUSTED_IN_APP --extended
```

Enter the password only at the hidden stdin prompt.

## Initial live-server run

Explicitly authorized by the user. Completed at 18:15 Asia/Colombo using the existing saved `ubuntu` profile and SSH host key already trusted in the desktop app. The password was supplied through hidden stdin, held only in memory and excluded from source, diagnostic output, command-line arguments and reports.

## Observed environment

- Ubuntu 26.04 LTS, x86_64.
- Six logical CPUs, 12,238,307,328 bytes RAM, 102,915,489,792-byte root filesystem.
- At the last sample: approximately 0.54% CPU, 11,305,095,168 bytes memory available, 4,064,149,504 bytes root disk used.
- 217 discovered systemd services; zero reported failed units.
- Authentication used the account’s existing permissions. No privilege escalation or service changes were attempted.

## Verified checks

1. Password authentication and matching previously trusted SSH host key.
2. SFTP listing of the account’s actual home directory.
3. Live CPU, memory, root disk and uptime monitoring.
4. Read-only systemd discovery and service details.
5. Process and listening-port discovery.
6. Journal query with the account’s permissions; journal visibility remains subject to server authorization.
7. Creation and verification of a new isolated temporary folder.
8. UTF-8 file creation, atomic replacement and stale-edit rejection.
9. Rename, staged copy, move and chmod of test-created files.
10. Recursive streaming upload of 1,048,608 bytes.
11. Recursive streaming download of the same bytes, with matching SHA-256 payload contents.
12. Interactive PTY input, output and resize.
13. Continued SFTP operation after closing the terminal channel.
14. Removal and verification of the test-created remote folder. Local temporary data also removed.

All writes and removals stayed beneath new `.vps-manager-smoke-<uuid>` home-directory children. Existing server content, running services, packages and configuration were left unchanged. Only the test controller’s own SSH connections were closed; the desktop app’s connection was not deliberately disconnected.

## Findings and limits

A late output acknowledgement after terminal closure initially threw from the test callback, which caused ssh2 to reset that test connection. The first temporary folder was removed through a new verified connection. Version 0.1.2 now tolerates late acknowledgements and closes the SSH shell channel without injecting text. The complete server workflow then passed with no unexpected transport loss or cleanup failures. A dedicated unit regression covers closure, late acknowledgement and transport independence.

The Windows capture helper returned `FrameArrived timed out` / `window capture timed out`, so no claim is made that the live native window, file picker or renderer was visually exercised. The checks invoked the same SSH/SFTP, file-operation, transfer, monitoring and terminal adapters used by the desktop application. Destructive service actions, arbitrary existing-file changes, intentional production connection interruption, stress testing and privilege elevation were not part of this smoke test.

The updated source passed lint, strict TypeScript, formatting and 59 unit tests. Three separate Electron regressions passed for development bootstrap, Windows URL-sensitive installation paths and packaged startup/reload. Those local UI checks used isolated application data and did not interact with the user’s connected desktop session.

## Updated package

`dist/VPS-Manager-0.1.2-x64-Setup.exe` — 128,083,310 bytes, unsigned.

```text
SHA-256: e15870b62c712e08d7ea4f2d9a953820b3b7d5ce802ef65b44b81f87e8bb5527
```

Restart the development app or install this package to load the terminal lifecycle change. The already-running app was not forcibly restarted during testing.

## Repeating explicitly

```powershell
node node_modules/tsx/dist/cli.mjs scripts/run-server-smoke.ts HOST_ALREADY_SAVED_AND_TRUSTED_IN_APP
```

Supply the password at the hidden stdin prompt. Never add a password as a command-line argument. The script does not run as part of `npm test` and cannot accept a new host key automatically.
