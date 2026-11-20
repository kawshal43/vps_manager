import { AppError } from '../errors/app-error'
import type { InstalledPackage } from './types'
export function packageName(value: string): string {
  if (!/^[a-z0-9][a-z0-9+.-]+(?::[a-z0-9][a-z0-9-]*)?$/.test(value) || value.length > 200)
    throw new AppError('INVALID_REQUEST', 'Invalid exact package identifier.')
  return value
}
export function packageProtection(pkg: InstalledPackage): string | undefined {
  if (pkg.essential || pkg.protected) return 'Marked Essential or Protected by dpkg.'
  if (pkg.held) return 'Held by the server’s package policy.'
  if (pkg.priority === 'required' || pkg.priority === 'important')
    return 'Required or important system component.'
  const name = pkg.name.split(':')[0]
  if (
    /^(?:apt(?:-|$)|dpkg(?:-|$)|sudo(?:-|$)|systemd(?:-|$)|openssh(?:-|$)|ssh$|linux(?:-|$)|grub|initramfs|init$|cloud-init$|netplan|network-manager|ifupdown|iproute2$|iptables|nftables|ufw$|dbus(?:-|$)|polkit|libc6(?:-|$)|libpam|libnss|bash$|dash$|coreutils$|util-linux$|mount$|passwd$|login$|ubuntu-(?:minimal|server)|ca-certificates$)/.test(
      name,
    )
  )
    return 'Protected operating-system, SSH, boot or networking component.'
  return undefined
}
export function criticalService(name: string): boolean {
  return /^(?:ssh(?:d)?|systemd.*|dbus|network.*|NetworkManager|ufw|firewalld|postgresql.*|mysql.*|mariadb.*)\.service$/i.test(
    name,
  )
}
export function parseSimulatedRemoval(output: string): string[] {
  if (/^(?:Inst|Conf)\s/m.test(output))
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The APT plan includes installation or configuration changes. Removal was blocked.',
    )
  const names = output
    .split('\n')
    .filter((line) => /^Remv\s/.test(line))
    .map((line) => packageName(line.trim().split(/\s+/)[1]))
  if (!names.length)
    throw new AppError(
      'FILE_CONFLICT',
      'APT did not propose removing the selected package. Refresh the inventory.',
    )
  return [...new Set(names)].sort()
}
export function parseActualRemoval(output: string): string[] {
  const section = /The following packages will be REMOVED:\s*\n([\s\S]*?)\n(?=\S)/.exec(output)
  const summary = /(\d+) upgraded, (\d+) newly installed, (\d+) to remove/.exec(output)
  if (!section || !summary || Number(summary[1]) || Number(summary[2]))
    throw new AppError(
      'FILE_CONFLICT',
      'The actual APT transaction could not be matched to the removal preview.',
    )
  const names = section[1]
    .trim()
    .split(/\s+/)
    .map((name) => packageName(name))
  if (new Set(names).size !== Number(summary[3]))
    throw new AppError('FILE_CONFLICT', 'The APT removal count changed. Refresh the preview.')
  return [...new Set(names)].sort()
}
export function equalPackageNames(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
}
