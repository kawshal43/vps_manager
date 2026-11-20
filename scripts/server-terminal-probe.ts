import { randomUUID } from 'node:crypto'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { SessionManager } from '../src/application/connection/session-manager'
import { TerminalManager } from '../src/application/terminal/terminal-manager'
import { FileOperations } from '../src/application/filesystem/file-operations'
import { mapError } from '../src/domain/errors/app-error'

export async function runTerminalProbe(input: {
  host: string
  secret: string
  settingsDirectory: string
  progress?: (message: string) => void
  immediate?: boolean
}): Promise<object> {
  const report = {
    phases: [] as string[],
    events: [] as string[],
    errors: [] as object[],
    serverLog: [] as string[],
    sshParent: '',
  }
  const repository = new SettingsRepository(input.settingsDirectory)
  await repository.load()
  const profile = repository.profiles().find((p) => p.host === input.host)
  if (!profile || !repository.hosts().some((h) => h.host === input.host && h.port === profile.port))
    throw new Error('A saved profile and previously trusted host key are required')
  const sessions = new SessionManager(
    repository,
    { encrypt: async () => '', decrypt: async () => '' },
    (e) => {
      if (e.type === 'session') report.events.push(e.session.state)
      if (e.type === 'host-challenge') sessions.trust(e.challenge.id, false)
    },
  )
  const connect = async () => {
    const session = await sessions.connect({
      profile: {
        id: randomUUID(),
        displayName: 'Read-only terminal probe',
        host: input.host,
        port: profile.port,
        username: profile.username,
        authenticationMethod: 'password',
      },
      secret: input.secret,
      rememberServer: false,
      rememberCredentials: false,
    })
    sessions
      .get(session.id)
      .client.on('error', (error: Error & { code?: string; level?: string }) => {
        report.errors.push({
          code: error.code,
          level: error.level,
          message: error.message.replaceAll(input.secret, '[redacted]').slice(0, 400),
        })
      })
    return session
  }
  try {
    const session = await connect()
    const connection = (await sessions.exec(session.id, 'printf \'%s\\n\' "$SSH_CONNECTION"'))
      .trim()
      .split(/\s+/)
    const clientPort = connection[1]
    const parent = (await sessions.exec(session.id, 'ps -o ppid= -p $$')).trim()
    if (/^\d+$/.test(parent)) report.sshParent = parent
    const fs = new FileOperations(sessions, async () => false).fs(session.id)
    const phase = async (name: string): Promise<boolean> => {
      try {
        await sessions.exec(session.id, 'true')
        await fs.list(session.home)
        report.phases.push(name + ': alive')
        input.progress?.(name + ': alive')
        return true
      } catch (error) {
        report.phases.push(name + ': ' + mapError(error, 'probe').code)
        return false
      }
    }
    await phase('before shell')
    let output = ''
    const terminal = new TerminalManager(sessions, (event) => {
      if (event.type === 'terminal-data') {
        output = (output + event.data).slice(-16000)
        try {
          terminal.ack(event.id, event.bytes)
        } catch {
          /* The tab may already have closed. */
        }
      }
    })
    const id = await terminal.open(session.id, 80, 24)
    terminal.ack(id, 0)
    terminal.input(id, "printf 'VPS_PROBE_%s\\n' READY\n")
    const deadline = Date.now() + 10000
    while (!output.includes('VPS_PROBE_READY') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100))
    report.phases.push(
      output.includes('VPS_PROBE_READY') ? 'shell output: received' : 'shell output: timeout',
    )
    await phase('after shell input')
    terminal.resize(id, 100, 30)
    if (!input.immediate) {
      await new Promise((r) => setTimeout(r, 500))
      await phase('after resize')
    }
    terminal.close(id)
    await new Promise((r) => setTimeout(r, 500))
    await phase('after shell close')
    const observer = await connect()
    if (report.sshParent) {
      const logs = await sessions.exec(
        observer.id,
        `LC_ALL=C journalctl --no-pager -n 30 -o cat _PID=${report.sshParent}`,
      )
      report.serverLog = logs
        .split('\n')
        .filter((line) => /error|fatal|disconnect|packet|session|close/i.test(line))
        .map((line) => line.replaceAll(input.secret, '[redacted]').slice(0, 400))
    }
    if (/^\d+$/.test(clientPort)) {
      const logs = await sessions.exec(
        observer.id,
        "LC_ALL=C journalctl --since '-3 minutes' --no-pager -n 200 -o short-iso -t sshd -t sshd-session",
      )
      const lines = logs.split('\n')
      const related = lines.filter((line) => line.includes(`port ${clientPort} `))
      const ids = related
        .map((line) => /sshd(?:-session)?\[(\d+)\]/.exec(line)?.[1])
        .filter(Boolean)
      report.serverLog.push(
        ...lines
          .filter((line) => related.includes(line) || ids.some((id) => line.includes(`[${id}]`)))
          .map((line) => line.replaceAll(input.secret, '[redacted]').slice(0, 400)),
      )
    }
  } catch (error) {
    report.errors.push(mapError(error, 'terminal.probe'))
  } finally {
    sessions.dispose()
    input.secret = ''
  }
  return report
}
