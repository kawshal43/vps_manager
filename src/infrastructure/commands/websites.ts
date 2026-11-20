import { posix } from 'node:path'
import { quotePosix as q } from '../../domain/filesystem/policy'
import {
  endpointSchema,
  serviceName,
  type Elevation,
  type WebsiteInput,
} from '../../domain/websites/types'
import { AppError } from '../../domain/errors/app-error'
import { safeGitUrl } from '../../domain/websites/policy'

export const docker = (elevation: Elevation) =>
  elevation === 'sudo' ? 'sudo -n -- /usr/bin/docker' : 'docker'
export function composeBase(config: WebsiteInput, elevation: Elevation, override?: string): string {
  if (!config.compose) throw new AppError('INVALID_REQUEST', 'Compose mapping is missing.')
  const c = config.compose
  return (
    `LC_ALL=C ${docker(elevation)} compose --project-name ${q(c.project)} --project-directory ${q(config.projectPath)}` +
    (c.envFile ? ` --env-file ${q(c.envFile)}` : '') +
    c.files.map((f) => ` -f ${q(posix.join(config.projectPath, f))}`).join('') +
    (override ? ` -f ${q(override)}` : '')
  )
}
export function composeAction(
  config: WebsiteInput,
  elevation: Elevation,
  action: 'config' | 'build' | 'activate' | 'logs' | 'restart',
  override?: string,
): string {
  const base = composeBase(config, elevation, override)
  const services = config.compose!.services.map((v) => q(serviceName.parse(v))).join(' ')
  switch (action) {
    case 'config':
      return `${base} config --format json`
    case 'build':
      return `${base} --progress plain build ${services}`
    case 'activate':
      return `${base} up -d --no-deps --no-build --pull never ${services}`
    case 'logs':
      return `${base} logs --no-color --tail 150 ${services}`
    case 'restart':
      return `${base} restart --no-deps ${services}`
  }
}
// Project metadata only: never request Config.Env, command arguments or arbitrary labels.
export function containerDiscoveryCommand(elevation: Elevation): string {
  const format =
    '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"directory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}'
  return `ids=$(LC_ALL=C ${docker(elevation)} ps -aq --no-trunc) || exit; for id in $ids; do ${docker(elevation)} inspect --format ${q(format)} "$id" || exit; done`
}
export function healthCommand(url: string): string {
  endpointSchema.parse(url)
  return `curl --silent --show-error --connect-timeout 5 --max-time 15 --output /dev/null --write-out '%{http_code}' --url ${q(url)}`
}
export function gitCloneCommand(url: string, revision: string, destination: string): string {
  safeGitUrl(url)
  if (!/^[a-fA-F0-9]{40}$/.test(revision))
    throw new AppError('INVALID_REQUEST', 'Select an exact 40-character commit SHA.')
  return `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -oBatchMode=yes -oStrictHostKeyChecking=yes' git clone --no-checkout --filter=blob:none -- ${q(url)} ${q(destination)} && git -C ${q(destination)} -c core.hooksPath=/dev/null checkout --detach ${q(revision)} && git -C ${q(destination)} rev-parse HEAD`
}
