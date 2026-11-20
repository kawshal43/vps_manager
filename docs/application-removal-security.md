# Application removal authorization design

This design precedes implementation of privileged removal commands.

## Scope and trust

The renderer can request an installed-package inventory, register a deployment, request a removal preview, or consume a short-lived removal token. It cannot supply commands, executable paths, package-manager options, sudo passwords or arbitrary root file paths. Every route retains the existing sender validation and strict Zod validation. Plans belong to one authenticated SSH session and expire after two minutes. Removing a saved deployment entry changes only local metadata.

APT inventory uses dpkg metadata, apt-mark manual/hold state and a hash of the package database. “Manually marked” can include preinstalled packages. “Optional” is a Debian package priority, not proof that software is unused or safe to uninstall. No automatic attempt is made to identify or remove everything that appears optional.

Primary command references: [apt-mark](https://manpages.ubuntu.com/manpages/resolute/man8/apt-mark.8.html), [apt-get](https://manpages.ubuntu.com/manpages/resolute/man8/apt-get.8.html), and [dpkg-query](https://manpages.ubuntu.com/manpages/resolute/man1/dpkg-query.1.html).

## Ubuntu package removal

Only exact installed package identifiers from the current inventory are accepted. Essential, Protected, held, required/important, kernel, SSH, network, boot, privilege-management and package-manager components are blocked. A real APT simulation supplies the preview; installs/upgrades, unknown packages, protected dependent removals and plans affecting more than 25 packages are rejected.

The actual command is fixed `apt-get remove`, with no purge, autoremove, downloads, automatic yes, essential-removal override or held-package override. The package database and preview are revalidated before execution. The real transaction's English removal proposal is compared with the preview before any yes response is sent. Unexpected changes abort the operation. Native confirmation occurs at that final prompt with the exact affected names and chosen privilege mode.

Default execution uses the SSH account’s existing permissions. The user may explicitly select existing sudo authorization for this one action; the fixed executable is invoked using `sudo -n`. This requires server-granted noninteractive authorization or an existing sudo ticket and never requests, reuses or stores unrestricted root credentials. If server policy denies it, the operation fails clearly. No new sudoers rule or agent is installed on production servers.

Once confirmed removal starts, the UI does not offer unsafe mid-dpkg cancellation. A transport failure/timeout after confirmation is reported as uncertain and never triggers automatic replay. Inventory is refreshed to verify the target and affected packages are absent. Maintainer scripts may stop services or change application-managed files; the UI does not promise that APT removal preserves every application data file.

## Registered deployments

Registration requires an accessible, canonical installation directory, outside protected locations and distinct from the account’s home directory itself. An optional systemd unit is a validated identifier, not an execution command. Removing the local entry never deletes remote files.

A deployment-file removal preview walks a bounded tree without following symlinks, checks protected descendants and records identities. The user sees the canonical path, recursive item/byte counts and linked service. Revalidation and native confirmation precede deletion. SFTP uses the account’s existing filesystem permissions; denied paths are never retried through sudo.

If a service is linked, the confirmed operation stops and disables it using existing authorization (or explicitly selected `sudo -n` for those two fixed systemctl actions). Critical services are blocked. Its unit definition is retained and this is disclosed in the preview. Files/configuration/databases outside the registered directory are untouched by the deletion operation. A partial failure is reported, without promising rollback. Local metadata is removed only after the directory's absence is confirmed.

## Review and validation gates

The design intentionally limits privilege to named package removals and named service stop/disable actions. It does not add a general elevation API. Tests must cover malicious identifiers, protected dependents, stale/foreign/expired tokens, changed transaction proposals, denied sudo, cancellation before confirmation and verified postconditions. Actual package/deployment removals are tested only on the disposable fixture. Live production validation is read-only unless the user explicitly approves a concrete removal through the application.
