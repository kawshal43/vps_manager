import { quotePosix } from '../../domain/filesystem/policy'
import { packageName } from '../../domain/applications/policy'
import type { Elevation } from '../../domain/applications/types'

export const packageInventoryCommand = `LC_ALL=C; export LC_ALL; printf '__UID__\\n'; id -u; printf '__MANUAL__\\n'; apt-mark showmanual && printf '__HELD__\\n' && apt-mark showhold && printf '__PACKAGES__\\n' && dpkg-query -W -f='\${binary:Package}\\t\${Version}\\t\${Architecture}\\t\${Installed-Size}\\t\${Essential}\\t\${Protected}\\t\${Priority}\\t\${db:Status-Status}\\t\${binary:Summary}\\n' && printf '__SNAPSHOT__\\n' && sha256sum /var/lib/dpkg/status`
const options =
  '-o APT::Color=0 -o APT::Get::AutomaticRemove=false -o APT::Get::Purge=false -o APT::Get::Assume-Yes=false -o APT::Get::Assume-No=false -o APT::Get::allow-remove-essential=false -o APT::Get::allow-change-held-packages=false -o APT::Get::allow-downgrades=false -o Dpkg::Use-Pty=0'
export function aptPreviewCommand(name: string): string {
  return `LC_ALL=C /usr/bin/apt-get --simulate ${options} remove -- ${quotePosix(packageName(name))}`
}
export function aptRemovalCommand(name: string, elevation: Elevation): string {
  return `LC_ALL=C; DEBIAN_FRONTEND=noninteractive; export LC_ALL DEBIAN_FRONTEND; ${elevation === 'sudo' ? 'sudo -n -- ' : ''}/usr/bin/apt-get --no-download --no-upgrade ${options} remove -- ${quotePosix(packageName(name))}`
}
