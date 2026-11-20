# Architecture

The application follows `user action → validated IPC → application operation → authenticated SSH/SFTP → verified result → UI refresh`.

## Boundaries

| Layer          | Location                  | Responsibility                                                                                               |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Domain         | `src/domain`              | Independent connection, filesystem, transfer, metrics, error types, path policies and connection transitions |
| Application    | `src/application`         | File use cases, transfer planning/queue, monitoring calculations and terminal lifecycle                      |
| Infrastructure | `src/infrastructure`      | SFTP adapter, approved command catalog, atomic JSON persistence, credential vault and diagnostics            |
| Electron       | `src/main`, `src/preload` | Native dialogs, session ownership, desktop lifecycle, request validation, events and the narrow bridge       |
| Presentation   | `src/renderer`            | React features, accessible dialogs/menus, asynchronous queries and local interface state                     |
| Contracts      | `src/shared`              | Zod input schemas, typed response map and event union                                                        |

`SessionManager` is the application layer’s shared connection registry, composed in the trusted Electron main process. Each session has an unguessable identity, one SSH transport, a reusable SFTP channel and its own shell/command channels. A session must be `CONNECTED` before normal operations can access it. Up to eight sessions can be open at once. The presentation never imports ssh2, Electron, or Node filesystem modules.

`FileOperations` coordinates validated filesystem use cases and one interactive file mutation at a time per session. `RemoteFs` resolves canonical parents, uses `lstat` for type checks, stages writes and validates results. The transfer engine uses the same filesystem policies independently of the explorer.

`TransferManager` plans directory trees and queues per-file jobs. Concurrency is globally bounded (1–4, default 2). Each job belongs to a session and a batch. “Apply to all” choices are serialized and scoped to the batch. Node streams use bounded SFTP read/write blocks with backpressure, operation timeouts and session-lifetime abort signals, including interrupted handle cleanup. Retries are explicit and start a fresh transfer after validating source and destination again. There is no unsafe resume or replay after disconnection.

`TerminalManager` opens SSH PTY shell channels. The renderer acknowledges bytes after xterm renders output; channels pause at 256 KiB outstanding and resume below 128 KiB. Initial output waits until the renderer has the terminal identity. The GUI command catalog and interactive terminal remain separate.

`ApplicationManager` reads installed dpkg metadata and APT marks, persists host/port/account-scoped deployment registrations and owns short-lived removal plans. Package execution revalidates the inventory and simulation, then `runAptRemoval` compares the actual APT prompt with the approved package set before requesting native confirmation. Deployment deletion revalidates a bounded tree manifest and uses the existing SFTP path policies. Optional explicit sudo authorization is restricted to the fixed removal and linked-service stop/disable catalogs; the renderer never supplies command text. See [the authorization design](application-removal-security.md).

## Renderer state

TanStack Query handles remote data and polling. Query keys include the session identity. The application store holds sessions, transfer snapshots and preferences. `src/renderer/src/desktop` owns the app registry, desktop shell, window frame and separate window/layout store. A single native Electron window hosts React app windows; opening an app focuses its existing server-scoped instance. Editors are scoped by live session and remote path; Settings is global.

Opened feature windows remain mounted across minimization and server switching. Terminal visibility and keyboard focus are separate, so another window taking focus does not hide or restart its shell. Hidden server views disable their remote queries and monitoring polls. Connection loss leaves the desktop and editor buffers mounted, disables remote operations and requires a deliberate new connection. Old-session drafts are never silently rebound to another connection. CodeMirror, xterm, Applications and Settings load in separate chunks. Each app window has its own error boundary.

Native file drops resolve to short-lived tokens in preload/main. Explorer captures the destination session and path before awaiting token resolution. Desktop drops capture the session and files, show a destination chooser, then use `transfers.desktopDrop`. Only the authenticated account's conventional home `Uploads` subfolder is created automatically; other paths must already exist. Both flows use the same transfer engine. Closing or minimizing a feature window does not own or cancel its transfer jobs. Closing Terminal explicitly disposes its mounted PTYs.

## Local persistence

Internal windows keep stable DOM order and use independent stacking ranks. Focusing a window does not detach its content, reset scroll positions or interrupt pointer gestures. Compact file views focus their grid without automatically scrolling its ancestors.

Desktop appearance is stored in a separate, versioned `workspace.json`, with bounded runtime validation, serialized atomic writes, server/account-scoped layouts, pinned apps and window geometry. Invalid/newer files are preserved and saving is disabled with a visible warning. Editor contents, remote file paths, terminal output, credentials and drop tokens are never stored in this layout. Terminal windows restore dormant and minimized; no SSH shell is automatically replayed. Window bounds are clamped to the current desktop area.

`settings.json` is versioned and validated on startup. Versions 0 and 1 migrate to version 2, which adds deployment registrations; version 1 profiles, preferences, trust and credential ciphertext are preserved. Invalid or newer data is preserved and startup reports the problem. Writes are serialized through a unique temporary file and rename; credentials are stored only as safeStorage ciphertext. No transfer or destructive application operation resumes automatically after restart. Older releases cannot read version 2 settings.

## Extending the product

Add domain types and runtime input schemas first. Define a narrow contract and application use case, implement the transport operation, then connect the interface. Add meaningful policy and disposable-server tests. Update documentation with actual verification outcomes. Privileged features require a specific authorization model; the narrow application-removal flow does not authorize adding generic sudo retries elsewhere.
