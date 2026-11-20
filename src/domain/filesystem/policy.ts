import { AppError } from '../errors/app-error'

export function validatePath(input: string): string {
  if (!input.startsWith('/') || /[\x00-\x1f\x7f]/.test(input) || input.length > 4096)
    throw new AppError('INVALID_PATH', 'Use an absolute POSIX path without control characters.')
  const parts: string[] = []
  for (const p of input.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') {
      parts.pop()
      continue
    }
    parts.push(p)
  }
  return '/' + parts.join('/')
}
export function validateName(name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\x00-\x1f\x7f]/.test(name) ||
    new TextEncoder().encode(name).length > 255
  )
    throw new AppError(
      'INVALID_PATH',
      'The filename is empty, too long, or contains a slash or control character.',
    )
  return name
}
const roots = [
  '/',
  '/home',
  '/root',
  '/tmp',
  '/var',
  '/var/lib',
  '/var/log',
  '/etc',
  '/usr',
  '/usr/local',
  '/opt',
  '/srv',
  '/mnt',
  '/media',
]
const protectedTrees = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/etc/ssh',
  '/etc/netplan',
  '/etc/network',
  '/etc/systemd',
  '/etc/sudoers.d',
  '/etc/ufw',
  '/etc/nginx',
  '/etc/ssl',
]
const protectedFiles = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/group',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/fstab',
  '/etc/hosts',
  '/etc/resolv.conf',
]
export function assertMutable(path: string): void {
  const clean = validatePath(path)
  if (
    roots.includes(clean) ||
    protectedFiles.includes(clean) ||
    protectedTrees.some((p) => clean === p || clean.startsWith(p + '/')) ||
    /\/(\.ssh)(\/|$)/.test(clean)
  )
    throw new AppError(
      'PERMISSION_DENIED',
      `VPS Manager protects this system location: ${clean}`,
      'Use the interactive terminal for deliberate administrator changes.',
    )
}
export function quotePosix(value: string): string {
  if (value.includes('\0'))
    throw new AppError('INVALID_REQUEST', 'A command argument contains a null byte.')
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
export function validateWindowsName(name: string): void {
  if (
    /[<>:"\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === '.' ||
    name === '..' ||
    name.includes('/')
  )
    throw new AppError(
      'INVALID_PATH',
      `Windows cannot store the filename “${name}”.`,
      'Rename the remote entry explicitly before downloading.',
    )
}
