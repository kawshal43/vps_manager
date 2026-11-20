# Security model

## Trust boundaries

The Windows account and application installation are trusted. Remote filenames, file contents, command output, server identities, and renderer IPC payloads are untrusted input. The desktop has no management cloud, mandatory account, telemetry, or credential upload service.

The Electron window runs with `nodeIntegration: false`, `contextIsolation: true`, renderer sandboxing and web security. It loads bundled local code (or the loopback development server), blocks unexpected navigation/new windows/webviews, denies permission requests, and has a restrictive CSP. The preload exposes typed operations, events, and native dropped-file tokens. It exposes no raw ipcRenderer, Node API, local path reader, or unrestricted GUI exec method.

Every IPC call checks the sending webContents, exact main frame and expected URL, then validates a fixed operation’s payload using a strict Zod schema. Server operations require a live authenticated session identity. Native local paths come from the file picker or Electron’s `webUtils.getPathForFile`; short-lived capability tokens authorize their use. A renderer-supplied private-key path is accepted only if it matches a previously saved profile reference.

## SSH identities and credentials

- First-use host challenges display address, key type, and SHA-256 fingerprint. Verify out of band before accepting.
- Trusted keys persist only after acceptance. Unexpected changes block authentication. Host history is retained.
- Passwords and key passphrases are session-only by default. Remembering requires an explicit saved profile and supported async Electron safeStorage.
- Async `isAsyncEncryptionAvailable`, `encryptStringAsync`, and `decryptStringAsync` use the operating system’s provider. On Windows this is OS-backed protection; another process running as the same Windows user may still access those secrets.
- Private keys are loaded only in the main process; working key buffers are zeroed after connection setup. JavaScript strings cannot be guaranteed to be erased from garbage-collected memory.
- Diagnostic logs contain only timestamp, known operation name and mapped error code. They omit payloads, credentials, key contents, filenames, shell output and raw stack traces.

Upstream references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [async safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), and [ssh2 transport API](https://github.com/mscdex/ssh2).

## Filesystem and command policy

Remote paths use POSIX semantics on every platform. Absolute paths and filenames are checked for control characters and invalid names. Canonical parent resolution prevents a symlinked parent from bypassing protected-location checks. Root, critical parent directories, system binaries, boot/runtime trees, SSH authentication locations, networking and sensitive configuration paths are protected. The authenticated home directory itself is protected by application file operations.

Recursive removal uses `lstat`, rechecks directory type and canonical path, and unlinks symlinks without traversing them. Permanent deletion and permission changes require native confirmations. Chmod accepts three octal permission digits and is never recursive. Ownership is not changed automatically except to preserve an existing target’s ownership on a staged replacement when the current account is permitted to do so.

Uploads and editor saves use unique temporary files on the target filesystem, verify transferred size and source identity, check conflicts again, preserve permissions/ownership when permitted, then publish with SFTP rename. Existing-file replacement requires the OpenSSH atomic rename extension. If unsupported, the original is preserved and the operation reports that limitation. Editor saves also compare SHA-256 content hashes, including same-size/same-timestamp changes.

Downloads reject symlinks, special files, invalid Windows names and unsafe local destination traversal. They check free space, write to temporary files, compare source attributes, revalidate local conflicts and rename only when complete.

GUI commands come from fixed catalog operations. Dynamic arguments are either strict service identifiers/numeric PIDs or robustly quoted POSIX arguments. Copy runs GNU `cp -a` into a unique staging path and publishes through a conflict-checked SFTP rename. Command output and lifetime are bounded. Return codes are checked; stderr is deliberately not displayed because it can contain secrets. The Services screen uses `systemctl --no-ask-password` without sudo. Native confirmation precedes all service changes, with additional text for sensitive services. SIGTERM requests recheck the process start time; PID 1 is excluded.

Application removal has a separate [authorization design](application-removal-security.md). Main-process plans are short-lived, single-use and session-bound. Package identifiers must match the installed inventory; protected components and dependents are blocked. The package database and APT simulation are revalidated, then the real locked removal proposal must match before native confirmation can authorize a yes response. There is no automatic yes, purge, autoremove or removal override.

The Applications removal flow can explicitly invoke existing noninteractive `sudo -n` authorization for the fixed apt-get removal command or a registered noncritical unit's stop/disable actions. It never requests sudo passwords, installs production sudoers rules or exposes arbitrary elevated exec. Ordinary service actions remain unchanged. Deployment deletion uses SFTP permissions only, with protected-path checks, bounded tree previews and revalidation. A linked systemd unit definition is retained.

## Operational limits

SFTP v3 path operations cannot guarantee immunity to a malicious concurrent process swapping remote directories between checks. Do not treat protected-path checks as an isolation boundary against a hostile account or server. Similarly, attribute checks plus rename are not filesystem transactions; remote writers can race a final commit. Use a dedicated account and coordinate concurrent edits for critical data.

Transferred byte counts and file attributes are verified; large-file content checksums are not negotiated. Explicit cancellation can leave partial recursive changes. Connection loss or process termination can leave `.vps-manager-*.part` or `.vps-manager-copy-*` staging entries, which are never presented as completed files. Inspect them before manual cleanup. Interrupted destructive commands are never replayed.

Clipboard, editor and terminal contents are visible to the local user. Closing a shell does not guarantee every remote background process it launched terminates. Choosing an administrative SSH account gives the interactive terminal that account’s real permissions. The app has no privilege broker or general sudo API. APT maintainer scripts execute with package-manager privileges, and interrupted uninstalls can leave uncertain state; they are never automatically repeated.

The initial installer is unsigned. Complete publisher signing, Windows 11 qualification, long-running tests and an independent security review before broad production distribution.
