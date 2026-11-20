import { quotePosix } from '../../domain/filesystem/policy'
import { AppError } from '../../domain/errors/app-error'
import type { ServiceAction } from '../../domain/monitoring/types'
export const discoveryCommand = `LC_ALL=C; export LC_ALL; printf '%s\\n' "$HOME"; hostname; uname -m; . /etc/os-release; printf '%s\\n' "$PRETTY_NAME"`
export const metricsCommand = `LC_ALL=C; export LC_ALL; head -n 1 /proc/stat; grep -c '^cpu[0-9]' /proc/stat; cat /proc/meminfo; printf '\\n__DISK__\\n'; df -Pk /; printf '__UPTIME__\\n'; cat /proc/uptime; cat /proc/loadavg`
export const servicesCommand =
  'LC_ALL=C systemctl list-units --type=service --all --no-pager --no-legend --plain'
export const processesCommand =
  'LC_ALL=C ps -eo pid,user,pcpu,pmem,etime,args --sort=-pcpu | head -n 101'
export const portsCommand = 'LC_ALL=C ss -lntup'
export function serviceName(name: string): string {
  if (!/^[a-zA-Z0-9_.@:\\-]+\.service$/.test(name) || name.startsWith('-') || name.length > 256)
    throw new AppError('INVALID_REQUEST', 'Invalid systemd service identifier.')
  return name
}
export function serviceDetailsCommand(name: string): string {
  return `LC_ALL=C systemctl show --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,CanReload,MainPID,FragmentPath,ExecMainStatus -- ${quotePosix(serviceName(name))}`
}
export function serviceActionCommand(name: string, action: ServiceAction): string {
  if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action))
    throw new AppError('INVALID_REQUEST', 'Invalid service action.')
  // No sudo or polkit password prompt. The current account must already be authorized.
  return `LC_ALL=C systemctl --no-ask-password ${action} -- ${quotePosix(serviceName(name))}`
}
export function logsCommand(name?: string): string {
  return `LC_ALL=C journalctl --no-pager -n 200 -o short-iso${name ? ` -u ${quotePosix(serviceName(name))}` : ''}`
}
