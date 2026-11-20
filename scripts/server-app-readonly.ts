import { randomUUID } from 'node:crypto'
import { SessionManager } from '../src/application/connection/session-manager'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { ApplicationManager } from '../src/application/applications/application-manager'

export async function inspectServerApplications(input: {
  host: string
  secret: string
  settingsDirectory: string
  progress?: (message: string) => void
}): Promise<object> {
  const repository = new SettingsRepository(input.settingsDirectory)
  await repository.load()
  const profile = repository.profiles().find((value) => value.host === input.host)
  if (
    !profile ||
    !repository.hosts().some((value) => value.host === input.host && value.port === profile.port)
  )
    throw new Error('A previously saved and trusted server is required')
  const sessions = new SessionManager(
    repository,
    { encrypt: async () => '', decrypt: async () => '' },
    (event) => {
      if (event.type === 'host-challenge') sessions.trust(event.challenge.id, false)
    },
  )
  try {
    const session = await sessions.connect({
      profile: {
        id: randomUUID(),
        displayName: 'Read-only app inventory',
        host: input.host,
        port: profile.port,
        username: profile.username,
        authenticationMethod: 'password',
      },
      secret: input.secret,
      rememberServer: false,
      rememberCredentials: false,
    })
    input.secret = ''
    const applications = new ApplicationManager(
      sessions,
      repository,
      async () => {
        throw new Error('This read-only validation never approves removal')
      },
      () => {},
    )
    const inventory = await applications.packages(session.id)
    input.progress?.('Read actual installed packages and APT marks without modifying the server')
    const candidate =
      inventory.packages.find((pkg) => pkg.name === 'xrdp') ??
      inventory.packages.find((pkg) => pkg.manual && !pkg.protectedReason)
    const preview = candidate
      ? await applications.prepare(session.id, 'package', candidate.name)
      : undefined
    input.progress?.('Generated an actual APT dry-run preview; no uninstall was executed')
    const core = inventory.packages.find((pkg) => pkg.name === 'openssh-server')
    const protectedPlan = core
      ? await applications.prepare(session.id, 'package', core.name)
      : undefined
    return {
      mode: 'read-only',
      installedPackages: inventory.packages.length,
      manuallyMarked: inventory.packages.filter((pkg) => pkg.manual).length,
      optionalPriority: inventory.packages.filter((pkg) => pkg.priority === 'optional').length,
      protectedPackages: inventory.packages.filter((pkg) => pkg.protectedReason).length,
      uid: inventory.uid,
      preview: preview && {
        target: preview.target,
        affected: preview.affected.map((pkg) => pkg.name),
        blocked: preview.blocked,
      },
      sshRemovalBlocked: !!protectedPlan?.blocked.length,
      serverChanges: false,
    }
  } finally {
    sessions.dispose()
    input.secret = ''
  }
}
