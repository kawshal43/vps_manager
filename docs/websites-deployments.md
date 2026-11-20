# Websites & Deployments

Open **Websites & Deployments** from the desktop launcher after connecting to Ubuntu. The app uses the current authenticated SSH/SFTP session. It installs no agent or administration panel. This feature is unreleased on `kawshal/Buildfeatures`; the application version remains 0.3.2 until a release is selected.

## Supported scope

| Area                                | Implemented behavior                                                                                                                                                                                                                         | Limits                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery                           | Read up to 100 Nginx `sites-enabled` files, follow enabled-config links for reading, parse server names, roots, proxy targets and TLS certificate paths; inspect Docker Compose labels, service states, published ports and image identities | Does not recursively expand arbitrary Nginx includes or infer variable/named upstream routes. Apache, Caddy and standalone systemd runtimes require manual import. Docker discovery is bounded to 500 containers.                                  |
| Compose updates                     | Existing local Docker build contexts; explicitly selected application services; separate build and service activation; versioned image tags; existing project name, environment, networks, volumes and dependencies retained                 | One identifiable container per selected service. No initial provisioning, image-only pulls, scaled replicas, external contexts, source bind mounts, mismatched/undeclared runtime mounts, privileged services, host networking or lifecycle hooks. |
| Static updates                      | Prebuilt assets with a root `index.html`; versioned releases and application-source snapshots                                                                                                                                                | Dedicated writable document root only; container bind-mounted roots are blocked. Runtime source, protected data and known overlapping website roots block activation.                                                                              |
| Node.js / Next.js, Spring Boot, PHP | Can be built by the existing project's Dockerfiles using the Compose adapter                                                                                                                                                                 | No standalone npm/Maven/Gradle/Composer/systemd deployment adapters. Static PHP deployment is blocked. Manual mappings are inspection only.                                                                                                        |
| Recovery                            | Verified application-source snapshots, retained previous Docker image references, explicit application restore and a backup of the current version before restoring                                                                          | No database or media backup/restore, migrations, automatic rollback, zero-downtime guarantee or host disaster recovery.                                                                                                                            |
| Routing / TLS                       | Existing Nginx configuration and certificate issuer/expiry information; separate application health and public routing checks; explicit Nginx syntax test and confirmed shared-service reload                                                | No DNS, Cloudflare, certificate issuance/renewal, automatic routing edits or SSL-renewal automation.                                                                                                                                               |

An unidentified source is shown as **Deployment source not identified — Import or configure website.** A detected document root is information about hosting, not proof of an application's source directory. Proxy-to-Compose association is attempted only for a unique project with a matching published loopback port.

## Import and prerequisites

1. Connect using the normal SSH workflow and verify the host key.
2. Discover websites, select a result and choose **Configure website**, or choose **Import website**.
3. Enter the real canonical project directory, public domain/URL, application health endpoint and readiness timeout (10–300 seconds).
4. For Compose, enter the actual existing Compose project name, relative configuration files and the exact application services, such as `web, api`. An optional environment file is an existing absolute server path; its contents are never shown or replaced.
5. Add any application-specific protected directories. Common data/media directories, environment files, keys, certificates and database dumps are always excluded. Bind-mounted project data is also protected automatically.

The account needs SFTP read access to source files and write access to the project's parent directory for managed release storage. Compose needs Docker Compose v2 with JSON configuration support and Docker daemon access. **Use existing noninteractive sudo for Docker / Nginx** is an explicit choice for the fixed command catalogs only; it does not grant SFTP privileges, ask for a sudo password or install sudoers rules. Ubuntu's GNU `df` and `curl` are required for storage and health verification; `openssl` is optional for certificate metadata, and `git` is required only for Git sources.

Registration and history are scoped by normalized host, SSH port and account. Existing website mappings with deployment history cannot be remapped, preserving the meaning of restoration points. Settings, credentials and developer credits are unchanged. Website metadata is stored separately in `websites.json`; invalid/newer/oversized files are preserved and disable this feature without disabling the other desktop apps.

## Updating a website

Choose **Update website**, then a source and method:

- **Full project update:** create a release containing the selected source's deployable files. Files absent from the source are absent from that release; the original Compose infrastructure directory is retained.
- **Partial update:** enter the exact relative files or directories. Start with the currently managed source and replace only selected paths; other deployable files remain.
- **Rebuild current source:** rebuild the latest managed source, or the original project before the first deployment.
- **Git revision:** select Git as the source and provide an exact 40-character commit SHA. A new isolated checkout is made on the VPS after checking a conservative 4 GiB checkout/cache allowance plus backup space; no development working tree is changed, and the deployment workflow never pushes Git changes. HTTPS URLs cannot contain credentials. SSH uses the server's existing access with batch mode and strict host-key checking. Private repository credentials are not configured by this app.

Local folders and ZIP archives use native Windows selection and session-bound capability tokens. ZIP entries are checked before extraction; traversal, links, special files, duplicate/case-colliding entries and oversized sources are rejected. A single archive wrapper directory becomes the source root. Deployable source manifests are bounded to 10,000 entries, 64 directory levels and 2 GiB. ZIP extraction also checks available local temporary storage before writing. Git fetch/checkout size is not predictable from the URL; use a trusted, appropriately sized repository and monitor server storage. Local junctions and source links are not traversed.

The preview shows files to add/change/remove, selected services, protected resources, storage, warnings and blockers. It is valid for ten minutes and is bound to the live session and website. A changed Compose file, migration files, unsupported/shared runtime or ambiguous mapping blocks deployment. Infrastructure changes need deliberate administration outside this source-update workflow; the wizard does not offer an override that silently replaces shared infrastructure.

Review all source, build and startup code. Acknowledge that the change performs no database migration, then approve the final native deployment confirmation. A build is code execution with the SSH/Docker account's existing permissions; staging is not a sandbox. Application code can itself modify a database or call other services. This engine cannot make untrusted application code safe or infer every migration hidden in startup code.

The engine revalidates source/configuration, copies and verifies an application backup, stages the release with streaming SFTP, checks SHA-256 after each upload, and builds selected services. It compares declared bind paths, named-volume identities and read/write modes with actual running mounts, blocks undeclared mounts, and rechecks runtime configuration and container identity after the build, before activation. Implicit image volumes and Docker config/secret mounts require manual management. Compose activation uses `up -d --no-deps --no-build --pull never` for the selected services only. It never uses `down`, volume removal, pruning, `--remove-orphans` or dependency recreation. New images have unique deployment tags; previous images receive retained backup tags.

The free-space preview covers application source, snapshots and release staging on the project's filesystem. Docker image/cache storage can be on another filesystem and build-time consumption is not predictable from source size; monitor that storage separately. A failed build does not trigger application activation.

Progress shows the stage, transferred bytes, average transfer rate, elapsed time and bounded sanitized logs. Cancellation is available during staging/builds. Once activation starts, cancellation is disabled while the operation verifies the transition. Stopping the Docker CLI does not guarantee its daemon has abandoned every build task. No activation is attempted after a cancelled/failed build.

## Release layout and recovery

Managed files live beside the registered project in `.vps-websites-<website UUID>/`:

```text
owner.json
releases/<operation UUID>/                 # versioned deployable source
releases/<operation UUID>.compose.json     # selected-service image/build override
backups/<operation UUID>/source/           # verified prior application source
backups/<operation UUID>/snapshot.json     # manifest and prior image references
backups/<operation UUID>/original/         # original static root on first activation
```

For Compose, the registered directory remains the infrastructure anchor for relative mounts, project identity and environment files. Current managed source is shown as **Active versioned source**, with **Open release files**. Running a manual Compose build from the original source bypasses this versioned workflow and can redeploy older source; use the GUI or deliberately inspect the active override first.

Static activation initially moves the original dedicated root into the backup area and installs a release symlink. There can be a brief routing interruption during that initial conversion. Later changes atomically replace the managed symlink using OpenSSH's rename extension. Protected-data roots and observed overlap with other websites are blocked. Static release directories are traversable by the web server; the backup directory is private to the SSH account. Existing filesystem ACLs, web-server policies and SELinux/AppArmor restrictions may require manual setup.

**Deployment history** shows operation/backup IDs, dates, outcomes, included components, byte size, verification status and deployment logs. **Restore previous version** verifies the snapshot, confirms application/database compatibility, backs up the current application and restores only the selected application's source/images. Database, media, environment and certificate data are not rolled back. Failed health/routing checks leave a failed outcome and an explicit recovery action, rather than silently reverting newer user data.

Application readiness checks the selected container's exact image identity, running state and reported health, plus the configured HTTP endpoint. Public HTTP(S) routing is a separate server-side request with normal TLS verification and no redirect following. These checks do not prove reachability from every external network or test application business behavior.

No operation is automatically replayed after an app restart or SSH disconnection. An unfinished persisted job becomes **interrupted**. Reconnect, inspect the actual containers/document root and use a verified restoration point if appropriate. Coordinate other operators and external deployment tools: SSH/SFTP checks are not transactions against concurrent changes by the same server account, and hostname aliases cannot establish a universal cross-tool lock.

Server releases/backups and Git preview checkouts are retained for manual inspection; there is no automatic deletion/retention job. Inspect the recorded paths and keep adequate disk space. Local ZIP staging is removed after preview discard or job completion; crashes can leave temporary folders. Local history retains the latest 1,000 operations, with a shared 4 MiB log budget favoring recent output. Live logs retain the latest 200 lines; application logs show up to 150 lines. Known environment/build-argument values, credential assignments and private-key blocks are redacted, but applications should never print credentials or arbitrary secrets.

## A Plus TV example

The supplied `aplustv.lk` / `nuranova.lk` configuration is an illustrative fixture only. It is not permission to connect to `15.235.243.194`. Register the actual Compose label/project name and files, preserve `/etc/apluskids/settings.env`, and select only the intended `web` / `api` services after validating their build contexts and storage mappings. Database/media services, private/public Nginx and other websites are not ordinary source-update targets. Shared/ambiguous mappings or migrations require manual separation and a separately tested database backup plan.

No production VPS has been accessed or modified while implementing/testing this feature.

## Implementation file map

| Area                 | New files                                                                                                                                                               | Modified integration points                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain and contracts | `src/domain/websites/types.ts`, `policy.ts`                                                                                                                             | `src/shared/schemas/index.ts`, `src/shared/contracts/api.ts`, `src/shared/workspace.ts`                                                                                                    |
| Application          | `src/application/websites/website-manager.ts`, `discovery.ts`, `adapters.ts`                                                                                            | `src/application/connection/session-manager.ts` (bounded UTF-8 command streaming)                                                                                                          |
| Infrastructure       | `src/infrastructure/websites/compose.ts`, `nginx.ts`, `project-io.ts`; `src/infrastructure/commands/websites.ts`; `src/infrastructure/persistence/websites.ts`          | `package.json`, `package-lock.json`, `eslint.config.mjs`                                                                                                                                   |
| Desktop / IPC        | `src/renderer/src/features/websites/Websites.tsx`, `websites.css`                                                                                                       | `src/main/ipc/register.ts`, `src/main/index.ts`, `src/renderer/src/desktop/Desktop.tsx`, `registry.ts`, `src/renderer/src/app/store.ts`, `src/renderer/src/features/explorer/Explorer.tsx` |
| Tests                | `tests/unit/websites.test.ts`, `website-deployments.test.ts`, `website-command-stream.test.ts`; `tests/fixtures/website-server.ts`; `tests/e2e/websites-native.spec.ts` | `tests/e2e/workspace.spec.ts`                                                                                                                                                              |
| Documentation        | `docs/websites-deployments.md`                                                                                                                                          | `README.md`, `docs/architecture.md`, `security.md`, `operations.md`, `testing.md`, `validation.md`, `release.md`                                                                           |
