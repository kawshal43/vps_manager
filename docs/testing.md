# Testing

## Fast checks

The desktop window/layout suite uses offline presentation fixtures with two servers; it exercises real Electron/preload code and disk-backed dropped Files, without claiming those fixtures are live server data. The native workspace test uses the real IPC handlers and layout file, rejects unexpected fields and checks cancelled native close. The real Ubuntu desktop test separately verifies native-backed desktop and explorer drops over SFTP, reads the uploaded content, and cleans up its isolated remote directory.

Clipboard tests use the real system clipboard and restore its previous formats afterward. The native test verifies validated clipboard IPC and right-click text-field menu roles. The terminal fixture test exercises mouse selection, right-click copy/paste, keyboard shortcuts, Ctrl+C interruption, multiline/bracketed paste, Unicode across the 64 KiB request boundary, and copying from Files and the editor into the terminal. Its SSH output/input is simulated; no server commands are executed.

```powershell
npm ci
npm run check
npm run format:check
npm audit
```

Unit tests cover path normalization/protection, filename/Windows-name checks, POSIX quoting, address and IPC validation, service identifiers, connection transitions, error redaction, file identity checks, atomic persistence, corruption preservation and Linux metric calculations.

The lockfile pins the tested dependency tree. A minimatch 11 override addresses the upstream advisory in build/lint dependencies; lint, package builds and tests validate compatibility. Runtime and full dependency audits are part of release checks.

## Disposable Ubuntu configuration

Use a test machine only. Tests create an isolated `.vps-manager-acceptance-<uuid>` directory beneath the test account’s home, perform file operations there and remove that directory. They do not use saved application profiles. The suite also verifies that protected paths and unauthorized service changes are rejected.

Create a JSON file outside version control:

```json
{
  "host": "TEST_HOST",
  "port": 22,
  "username": "TEST_USER",
  "password": "OPTIONAL_TEST_PASSWORD",
  "keyPath": "C:\\path\\to\\test_private_key",
  "fingerprint": "SHA256:INDEPENDENTLY_VERIFIED_FINGERPRINT"
}
```

Keep credentials in that local file only. Configure an otherwise harmless system service named `vps-manager-test.service` for discovery/denial tests. The test account must lack permission to restart this system service. The fixture VM creates a sleep-only service specifically for this purpose.

```powershell
$env:VPS_TEST_CONFIG = 'C:\path\to\disposable-test.json'
$env:VPS_TEST_ALLOW_DISPOSABLE = '1'
npm run test:ubuntu
npm test
npm run build
npm run test:e2e
```

The Ubuntu suite tests first-use trust against a known fixture fingerprint, password/key authentication, bad credentials, changed keys, SFTP listing, text conflicts, safe replacements, copy/rename, malicious filenames, chmod, symlink deletion, recursive streaming transfers, cancellation, connection interruption, real metrics, service authorization, terminal lifecycle and cleanup. Tests never automatically trust an unknown fingerprint.

The Playwright suite launches actual Electron with separate temporary application data and tests the complete login/files/editor/upload/terminal/services/disconnect workflow, IPC validation, sandboxing, saved profile restoration and opt-in OS credential encryption. A separate test boots the development renderer against a loopback Vite server and checks the desktop bridge. Native picker and native confirmation return values are supplied by the test harness; the SSH/SFTP operations themselves are real. Native dialog interaction and assistive-technology testing remain manual release checks.

## Optional local VirtualBox fixture

Requires VirtualBox and Python. It creates only the VM named `VPS-Manager-Acceptance` beneath `.test-data/ubuntu`, with 2 CPUs, 2 GiB RAM and loopback-only SSH forwarding on port 22222. Existing VMs are not modified. Generated client/host keys and a random test password remain in ignored `.test-data`.

```powershell
New-Item -ItemType Directory -Force .test-data/ubuntu
curl.exe --fail --location --output .test-data/ubuntu/noble.vmdk https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.vmdk
python -m pip install --target .test-data/python pycdlib
python scripts/create-test-vm.py
```

The helper checks the image SHA-256 against Ubuntu’s official checksum manifest before provisioning, generates a cloud-init seed and starts the VM headlessly using BIOS. Allow Ubuntu/cloud-init to finish before running tests. With this fixture, the scripts default to `.test-data/ubuntu/connection.json`.

After testing:

```powershell
& 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe' controlvm VPS-Manager-Acceptance acpipowerbutton
```

To test an unpacked/installed build, set `VPS_TEST_EXECUTABLE` to its `VPS Manager.exe` and run `npm run test:e2e`. The test still uses isolated application data. Installer qualification should use a separate install directory and check uninstall behavior, signatures and both supported Windows versions.

## Application-removal fixture

Actual uninstall tests are restricted to the named loopback fixture (`127.0.0.1:22222`, account `vpstest`). Never point these scripts at a production server. With the fixture powered off, `python scripts/prepare-package-fixture.py` prepares a separate cloud-init seed and starts only `VPS-Manager-Acceptance` after checking its workspace configuration path. The seed preserves its host identity, installs the harmless `hello` package and grants test-only noninteractive apt-get and exact fixture-service stop/disable permissions. This authorization belongs only on the disposable VM.

```powershell
npx tsx scripts/application-acceptance.ts
$env:VPS_TEST_ALLOW_DISPOSABLE = '1'
npx playwright test applications.spec.ts
```

The adapter suite performs actual APT cancellation/removal, restores `hello`, rejects protected/stale/foreign previews, verifies local-entry removal preserves files, and deletes only fresh UUID-named deployment directories. It stops/disables the sleep-only fixture service and verifies its unit definition is retained. The desktop test verifies filters, protected-package controls, registration, entry-only removal, cancellation and confirmed directory deletion through the real Electron IPC and SSH/SFTP stack. Native confirmation answers are supplied by the harness. Temporary app data and test directories are cleaned up.

The full desktop workflow checks discovery of `ssh.service`, so it does not depend on the sleep-only service still being active after removal testing. The separate service-authorization test continues to require that restarting the fixture service is denied.

On this Windows host, the previously used stream-optimized cloud-image/differencing disk stopped booting. The fixture's disk was cloned to a normal VDI and booted successfully with one vCPU. This was a change only to the disposable VM; the preparation script does not automatically repair disks. Ensure the fixture boots before running acceptance tests.

For explicitly authorized production **read-only** validation, `scripts/run-server-smoke.ts HOST --apps-readonly` reads package metadata and APT simulation results; `--apps-ui-readonly` checks the table, search, removal preview and registration form using temporary user data. Both require an already saved/trusted host and read a password through hidden stdin. Neither executes uninstall or saves a deployment on the server. Do not place passwords in arguments or test files.

## Manual release checks

Verify native picker and drag-and-drop workflows, replacement confirmation choices, changed-key warning readability, keyboard-only context menus, screen reader behavior, high DPI and 960×640 resizing, Windows 11, 10,000-entry folders, multi-GiB transfers, disk-full behavior, abrupt termination, reconnect recovery and extended multi-server sessions. Performance targets depend on real servers and networks; no throughput or memory guarantee is inferred from local fixture tests.
