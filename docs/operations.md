# Using VPS Manager

## Desktop workspace

After connecting, double-click Files, Terminal or Server on the desktop, or click their taskbar icons. The launcher (Ctrl+K) contains all tools and supports search and pin/unpin controls. Server contains Overview, Services, Monitoring and Logs. Applications and Settings open in separate windows.

Drag internal window title bars to move them; drag an edge or corner to resize. Double-click a title bar to maximize/restore. A taskbar app button restores a minimized window, focuses an existing window, or minimizes the focused window. The right edge of the taskbar shows the desktop. Ctrl+F6 cycles windows; Ctrl+Alt+D minimizes current workspace windows. Focus a title bar and use Ctrl+Arrow to move or Ctrl+Shift+Arrow to resize.

The taskbar server menu adds connections, switches workspaces and disconnects. Minimized windows keep their terminals, file navigation and editor drafts. Transfer jobs continue after closing Files. Closing Terminal asks before ending its shells. Offline workspaces retain editor text in memory; open the old server workspace to copy a draft before closing it. Reconnecting creates a new authenticated session and never silently transfers old editor drafts to that connection.

Layout and pinned apps are saved in workspace.json beside settings.json. Editor contents are not persisted. After restarting and connecting, ordinary app layouts restore; terminal windows wait minimized until explicitly opened, starting fresh shells. Save editor changes before quitting.

Drop files/folders from Windows onto the desktop to choose a destination. The conventional Uploads folder in the server account's home is created only after submitting the upload. Other destination folders must already exist. Dropping into Files uploads directly to its displayed folder. The destination server and path stay attached to the drop even if you switch workspaces during preparation.

## Connect

Enter an Ubuntu host (IPv4, IPv6, or DNS name), SSH port, username and password or private key. A key’s passphrase is optional when unencrypted. Check **Save server profile** to keep non-sensitive connection information; credential remembering is off by default and uses Windows secure storage when available.

On first contact, compare the displayed SHA-256 SSH fingerprint against your provider’s console or another trusted source. Trust only after it matches. Future unexpected changes block the connection. If your provider intentionally rotates a host key, verify the rotation and back up the local settings before deliberately updating the trusted key history. There is no “ignore verification” option.

Saved profiles restore connection details and the last selected profile. Login is always required. Add another connection and switch between sessions in the taskbar server menu. Disconnect closes that server’s channels and cancels its transfers; the Ubuntu machine keeps running.

## Files

Double-click folders, or enter an absolute path. Back/Forward/Up/Home and breadcrumbs navigate normally. The dotfile button toggles hidden entries. Sorting keeps folders first. Use Ctrl or Shift for selection, or file checkboxes. Right-click or Shift+F10 opens a keyboard-accessible context menu.

Upload files or a complete folder with the native picker. Dragging local files/folders into the explorer uploads to the displayed directory. Download asks for a local destination. Existing folders are merged while file conflicts offer Skip, Replace, Keep both, or Cancel batch. “Apply to remaining conflicts” affects that batch only. Unsupported symlinks/special files or Windows names produce an explicit error; names are never silently changed.

Use Transfers to see bytes, progress, speed and ETA. Cancellation is supported. Retry validates and restarts a transfer; pause/resume is deliberately unavailable. Jobs belong to the original session. After a lost connection, inspect the destination, reconnect and explicitly queue new transfers. Queue metadata is retained in memory, not restored across application restarts.

Copy, Cut/Paste and Move never silently overwrite destinations. Cross-filesystem moves can be rejected by the server; use copy, verify, and deliberate deletion instead. Delete is permanent and requires native confirmation showing the selected paths. Recursive operations can stop after partial work if a permission, protected location, cancellation or connection error is encountered. Refresh and inspect the actual filesystem before retrying. Long file copies/deletions expose **Cancel file operation**; already completed changes are not rolled back.

Properties displays type, byte size, modification time, UID/GID and Unix permissions. Permission changes use the authenticated user’s rights. GUI operations never retry using sudo. For a deliberate protected system administration task, use Terminal.

## Editor

Double-click a regular file, or a symlink whose resolved target is a regular file. UTF-8 text up to 2 MiB is supported. Binary files and other encodings should be downloaded. The editor preserves UTF-8 BOM and LF/CRLF conventions, highlights common languages, and provides line numbers, wrap, read-only mode, search/replace, Ctrl+S, Save As, and Reload.

Saving detects external changes through attributes and a content hash. If there is a conflict, use Save As to preserve your edits or Reload to fetch the server version. Existing-file saves require atomic replacement support. Unsaved editors ask before dismissal. Save or close editors before disconnecting or quitting.

## Terminal

Each tab is a real SSH shell with a PTY. Use **Open terminal here** from Files to open in a directory. Terminal text search works on scrollback. Select text and right-click to copy it to the system clipboard. The selection clears after copying; right-click without a selection to paste text from any app. Ctrl+Shift+C or Ctrl+Insert copies; Ctrl+V, Ctrl+Shift+V or Shift+Insert pastes. Ctrl+C copies selected text and otherwise interrupts the running command. Multiline paste follows the shell's bracketed-paste mode. Links ask before opening an HTTP(S) browser destination. User-typed shell commands execute with the connected account’s permissions.

## Websites & Deployments

Open the app from the launcher. Discover the current server's Nginx/Compose hosting, import a verified project mapping, then choose Update website for a native Windows folder/ZIP, isolated exact Git revision, remote source or rebuild. Review the diff, protected resources and blockers; acknowledge application/database limitations and approve the native confirmation. Progress, logs, health and application-only restoration points stay with that server's workspace. Files and Terminal actions reuse the existing desktop apps.

Only selected-service Docker Compose builds and dedicated prebuilt static roots support managed deployment. Standalone Node.js/Java/PHP, Apache/Caddy management, migrations, database/media backups, SSL renewal and automatic DNS/routing changes require manual administration. Application restores do not overwrite current database/media data. Follow [the deployment guide](websites-deployments.md) for prerequisites, storage layout, backup limits, Git access and recovery after interruption.

## Monitoring, services and applications

Overview/Monitoring reads actual `/proc`, `df`, hostname and OS information. CPU needs two samples, so the first sample says “Sampling”. RAM usage uses MemAvailable. Monitoring polls only while its view is active, pauses in the background using the query library’s visibility behavior, and stops on disconnect.

Services lists actual systemd units. Open a service to inspect enabled state, capabilities and recent logs. Start/Stop/Restart/Enable/Disable, and supported Reload, use existing system authorization and require confirmation. The Services screen does not retry through sudo. Logs shows the latest 200 visible journal entries.

## Applications

**Ubuntu packages** lists installed dpkg packages with versions, installed sizes, descriptions, priorities and APT marks. Search by name, version or description. Choose Manually marked, All installed, Automatic dependencies or Optional priority. Protected system components are hidden by default; uncheck the protection filter to inspect them. Their uninstall action remains blocked.

APT's manual mark can include software preinstalled by Ubuntu or your hosting provider. Optional is package priority, not a reliable list of unused or safe-to-delete apps. Check what a package does before removing it.

Choose **Uninstall…** to see APT's actual dependency-removal preview, including every affected package. The preview expires after two minutes. Root accounts can continue with their existing permissions; other accounts must explicitly select **Use existing sudo authorization for this action**. This uses `sudo -n` and requires permission already granted on the server. It does not ask for a sudo password or change server authorization. Permission failures leave the result visible for review.

Final native confirmation occurs only after the real APT transaction matches the preview. The app blocks essential, protected, held and core system/SSH/network/boot packages, protected dependent removals and plans exceeding 25 packages. It uses remove without purge or autoremove; package maintainer scripts can still stop services or change app-managed data. Keep the app open once removal begins. If the connection fails, inspect package state before trying again; removal is never replayed automatically.

**My deployments** manages directories that you register using **Add deployed app**. Enter an app name, its existing absolute installation directory, optional systemd service name and notes. This records the app locally; it does not install or start it. Uploading a folder does not automatically add it here. Registrations are scoped to the server address, SSH port and username and show whether the directory is present, missing or unavailable.

**Remove from list** changes only the saved entry on this computer. **Remove files…** previews the canonical directory and recursive entry/byte counts, then requires native confirmation before permanent deletion. Removal uses your SFTP account's filesystem permissions and never retries deletion using sudo. Protected locations, the account's home directory itself, symlinked installation directories and previews exceeding 10,000 entries or 64 levels are rejected. File changes invalidate the preview.

If a noncritical systemd service is linked, file removal first stops and disables it using the current account or explicitly selected existing sudo authorization. Its unit definition is retained, as disclosed in the preview. Files and databases outside the installation directory are not deleted. Partial changes are not rolled back. Use Terminal for any separate unit-file cleanup after reviewing the result.

**Processes & ports** retains the actual running-process and listening-port views, with text search and a kernel-thread filter. Process inspection can request confirmed SIGTERM after checking the process start identity. Snap, Docker, pip and npm installations do not have dedicated automatic inventories or uninstall workflows in this release.

## Local data and troubleshooting

Electron’s per-user application-data directory contains `settings.json`. On a normal Windows installation this is under `%APPDATA%/vps-manager`. Keep this file private even though saved credentials are encrypted. Settings lets you forget credentials and open diagnostic logs. Invalid settings are preserved; back them up before repair. No secrets or raw server output are written to diagnostics.

Version 0.2.0 migrates settings to version 2, adding registered deployment metadata while preserving profiles, trust and credential ciphertext. Close older app instances before upgrading. Older releases reject version 2 data; use a private pre-upgrade backup if rolling back.

SSH success with unavailable SFTP leaves Terminal and monitoring usable. Check the server’s OpenSSH SFTP subsystem. For denied filesystem actions, check Linux permissions. For a service failure, inspect its status and logs in Terminal. A connection loss makes in-flight results uncertain; verify state before repeating a change.
