import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { SessionManager } from '../src/application/connection/session-manager'
import { FileOperations } from '../src/application/filesystem/file-operations'
import { TransferManager } from '../src/application/transfers/transfer-manager'
import { TerminalManager } from '../src/application/terminal/terminal-manager'
import { Monitoring } from '../src/application/monitoring/monitoring'
import { AppError, mapError } from '../src/domain/errors/app-error'
import {
  logsCommand,
  portsCommand,
  processesCommand,
  serviceDetailsCommand,
  servicesCommand,
} from '../src/infrastructure/commands/catalog'
import { removeTestDirectory } from './test-temp'
import { runExtraChecks } from './server-extra-checks'

interface ServerSmokeInput {
  host: string
  secret: string
  settingsDirectory: string
  cleanupPrevious?: string
  extended?: boolean
  progress?: (message: string) => void
}
export interface ServerSmokeReport {
  startedAt: string
  completedAt?: string
  host: string
  username?: string
  fingerprint?: string
  distribution?: string
  home?: string
  hostname?: string
  architecture?: string
  checks: string[]
  limited: string[]
  error?: { code: string; message: string }
  testDirectory?: string
  remoteCleanup: boolean
  localCleanup: boolean
  metrics?: {
    cpuPercent: number | null
    cpuCount: number
    memoryTotal: number
    memoryAvailable: number
    diskTotal: number
    diskUsed: number
    uptime: number
  }
  serviceCount?: number
  failedServices?: string[]
  uploadBytes?: number
  downloadBytes?: number
  transportEvents: string[]
}

/** Explicitly invoked, bounded checks against a host already trusted in the app.
 * Passwords are supplied in memory and are never included in reports or files.
 * All writes and cleanup are confined to a newly created home-directory child.
 */
export async function runServerSmoke(input: ServerSmokeInput): Promise<ServerSmokeReport> {
  const report: ServerSmokeReport = {
    startedAt: new Date().toISOString(),
    host: input.host,
    checks: [],
    limited: [],
    remoteCleanup: false,
    localCleanup: false,
    transportEvents: [],
  }
  const pass = (message: string): void => {
    report.checks.push(message)
    input.progress?.(message)
  }
  const repository = new SettingsRepository(input.settingsDirectory)
  await repository.load()
  const profile = repository.profiles().find((p) => p.host === input.host)
  if (!profile)
    throw new AppError('INVALID_REQUEST', 'No saved profile matches the requested host.')
  const trusted = repository
    .hosts()
    .filter((h) => h.host === input.host.toLowerCase() && h.port === profile.port)
    .at(-1)
  if (!trusted)
    throw new AppError(
      'HOST_KEY_ERROR',
      'Accept the server identity in the app before running this test.',
    )
  report.username = profile.username
  report.fingerprint = trusted.fingerprint
  const vault = {
    encrypt: async (): Promise<string> => {
      throw new Error('Credential persistence is disabled during smoke testing')
    },
    decrypt: async (): Promise<string> => {
      throw new Error('Saved secrets are not used during smoke testing')
    },
  }
  const sessions = new SessionManager(repository, vault, (event) => {
    if (event.type === 'session') report.transportEvents.push(event.session.state)
    if (event.type === 'host-challenge') sessions.trust(event.challenge.id, false)
  })
  let sessionId: string | undefined
  let local: string | undefined
  let created = false
  let root: string | undefined
  let home: string | undefined
  let transfers: TransferManager | undefined
  try {
    const session = await sessions.connect({
      profile: {
        id: randomUUID(),
        displayName: 'Explicit server smoke test',
        host: input.host,
        port: profile.port,
        username: profile.username,
        authenticationMethod: 'password',
      },
      secret: input.secret,
      rememberServer: false,
      rememberCredentials: false,
    })
    sessionId = session.id
    report.hostname = session.hostname
    report.distribution = session.distribution
    report.architecture = session.architecture
    report.home = session.home
    pass('SSH password authentication and previously trusted host key')
    assert.equal(session.sftp, true, 'SFTP must be available')
    const operations = new FileOperations(sessions, async () => {
      throw new Error('Interactive destructive operations are not part of this smoke test')
    })
    const fs = operations.fs(session.id)
    sessions.get(session.id).client.on('error', (error) => {
      report.transportEvents.push(`client-error:${mapError(error, 'transport').code}`)
    })
    sessions.get(session.id).client.on('end', () => report.transportEvents.push('client-end'))
    sessions.get(session.id).client.on('close', () => report.transportEvents.push('client-close'))
    sessions.fs(session.id).on('end', () => report.transportEvents.push('sftp-end'))
    sessions.fs(session.id).on('close', () => report.transportEvents.push('sftp-close'))
    home = await fs.realpath(session.home)
    if (input.cleanupPrevious) {
      assert.equal(posix.dirname(input.cleanupPrevious), home)
      assert.match(posix.basename(input.cleanupPrevious), /^\.vps-manager-smoke-[0-9a-f-]{36}$/)
      assert.equal(await fs.realpath(input.cleanupPrevious), input.cleanupPrevious)
      assert.equal(
        (await fs.text(posix.join(input.cleanupPrevious, 'copies/moved.json'))).content,
        '{"vpsManagerSmoke":2}\n',
      )
      await fs.remove(input.cleanupPrevious)
      assert.equal(await fs.exists(input.cleanupPrevious), null)
      pass('Verified and removed the previous test-created temporary folder')
    }
    await fs.list(home)
    pass('SFTP home-directory listing')
    const monitoring = new Monitoring(sessions)
    await monitoring.get(session.id)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const metrics = await monitoring.get(session.id)
    assert.ok(metrics.memoryTotal > 0 && metrics.diskTotal > 0 && metrics.cpuCount > 0)
    report.metrics = {
      cpuPercent: metrics.cpuPercent,
      cpuCount: metrics.cpuCount,
      memoryTotal: metrics.memoryTotal,
      memoryAvailable: metrics.memoryAvailable,
      diskTotal: metrics.diskTotal,
      diskUsed: metrics.diskUsed,
      uptime: metrics.uptime,
    }
    pass('Live CPU, memory, disk and uptime monitoring')
    const services = (await sessions.exec(session.id, servicesCommand))
      .trim()
      .split('\n')
      .filter(Boolean)
    report.serviceCount = services.length
    report.failedServices = services
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[2] === 'failed')
      .map((parts) => parts[0])
    const ssh = services
      .map((line) => line.trim().split(/\s+/)[0])
      .find((name) => name === 'ssh.service' || name === 'sshd.service')
    if (ssh) await sessions.exec(session.id, serviceDetailsCommand(ssh))
    pass('Actual systemd service discovery and read-only details')
    await sessions.exec(session.id, processesCommand)
    await sessions.exec(session.id, portsCommand)
    pass('Process and listening-port discovery')
    try {
      await sessions.exec(session.id, logsCommand(ssh))
      pass('Journal logs readable with the account’s permissions')
    } catch (error) {
      report.limited.push(mapError(error, 'logs.read').message)
    }

    root = posix.join(home, `.vps-manager-smoke-${randomUUID()}`)
    assert.equal(await fs.exists(root), null)
    await fs.mkdir(root)
    created = true
    report.testDirectory = root
    assert.equal((await fs.list(root)).entries.length, 0)
    pass('Created and verified an isolated temporary folder')
    const path = posix.join(root, 'smoke.json')
    const original = await fs.save(path, '{"vpsManagerSmoke":1}\n', null)
    const updated = await fs.save(path, '{"vpsManagerSmoke":2}\n', original.identity)
    assert.equal(updated.content, '{"vpsManagerSmoke":2}\n')
    await assert.rejects(fs.save(path, 'stale version', original.identity), /changed/)
    pass('UTF-8 file creation, atomic save and stale-edit protection')
    const renamed = posix.join(root, 'renamed.json')
    await fs.rename(path, renamed)
    const copies = posix.join(root, 'copies')
    await fs.mkdir(copies)
    await operations.copy(session.id, [renamed], copies)
    assert.equal((await fs.text(posix.join(copies, 'renamed.json'))).content, updated.content)
    const moved = posix.join(copies, 'moved.json')
    await fs.rename(renamed, moved)
    await fs.chmod(moved, 0o600)
    assert.equal((await fs.lstat(moved)).mode & 0o777, 0o600)
    pass('Rename, staged server-side copy, move and permissions on test files')

    local = await mkdtemp(join(tmpdir(), 'vps-server-smoke-'))
    const upload = join(local, 'project')
    await mkdir(join(upload, 'nested'), { recursive: true })
    const payload = randomBytes(1024 * 1024)
    const checksum = createHash('sha256').update(payload).digest('hex')
    await writeFile(join(upload, 'nested', 'payload.bin'), payload)
    await writeFile(join(upload, 'readme.txt'), 'VPS Manager explicit smoke test\n')
    const download = join(local, 'download')
    await mkdir(download)
    transfers = new TransferManager(
      sessions,
      () => {},
      async () => {
        throw new Error('Unexpected conflict: the smoke test will not overwrite pre-existing data')
      },
    )
    const wait = async (): Promise<void> => {
      const deadline = Date.now() + 90000
      while (
        transfers!.list().some((job) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status))
      ) {
        if (Date.now() > deadline)
          throw new AppError('OPERATION_TIMEOUT', 'The bounded transfer test timed out.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const failures = transfers!.list().filter((job) => job.status !== 'COMPLETED')
      if (failures.length)
        throw new AppError(
          'TRANSFER_INTERRUPTED',
          failures[0].error || 'A test transfer did not complete.',
        )
    }
    await transfers.upload(session.id, [upload], root, 'ask')
    await wait()
    report.uploadBytes = transfers
      .list()
      .filter((job) => job.direction === 'upload')
      .reduce((sum, job) => sum + job.transferred, 0)
    pass('Recursive streaming upload and verified transfer completion')
    await transfers.download(session.id, [posix.join(root, 'project')], download, 'ask')
    await wait()
    const received = await readFile(join(download, 'project', 'nested', 'payload.bin'))
    assert.equal(createHash('sha256').update(received).digest('hex'), checksum)
    assert.equal(
      await readFile(join(download, 'project', 'readme.txt'), 'utf8'),
      'VPS Manager explicit smoke test\n',
    )
    report.downloadBytes = transfers
      .list()
      .filter((job) => job.direction === 'download')
      .reduce((sum, job) => sum + job.transferred, 0)
    pass('Recursive streaming download with matching SHA-256 contents')

    if (input.extended) await runExtraChecks(sessions, session.id, root, local, pass)

    let output = ''
    const terminal = new TerminalManager(sessions, (event) => {
      if (event.type === 'terminal-data') {
        output = (output + event.data).slice(-16384)
        terminal.ack(event.id, event.bytes)
      }
    })
    const terminalId = await terminal.open(session.id, 80, 24, root)
    try {
      terminal.ack(terminalId, 0)
      terminal.input(terminalId, "printf 'VPS_MANAGER_SMOKE_%s\\n' VERIFIED\n")
      const deadline = Date.now() + 15000
      while (!output.includes('VPS_MANAGER_SMOKE_VERIFIED')) {
        if (Date.now() > deadline)
          throw new AppError('OPERATION_TIMEOUT', 'Interactive terminal test timed out.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      terminal.resize(terminalId, 100, 30)
      pass('Interactive SSH PTY input, output and resizing')
    } finally {
      terminal.close(terminalId)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    await fs.list(root)
    pass('SFTP remains available after closing the terminal channel')
  } catch (error) {
    const mapped = mapError(error, 'server.smoke')
    report.error = { code: mapped.code, message: mapped.message }
  } finally {
    transfers?.cancelAll()
    if (created && sessionId && root && home) {
      try {
        assert.equal(posix.dirname(root), home)
        assert.match(posix.basename(root), /^\.vps-manager-smoke-[0-9a-f-]{36}$/)
        let cleanupId = sessionId
        try {
          await new FileOperations(sessions, async () => false).fs(cleanupId).realpath(root)
        } catch {
          const reconnect = await sessions.connect({
            profile: {
              id: randomUUID(),
              displayName: 'Test cleanup',
              host: input.host,
              port: profile.port,
              username: profile.username,
              authenticationMethod: 'password',
            },
            secret: input.secret,
            rememberServer: false,
            rememberCredentials: false,
          })
          cleanupId = reconnect.id
          report.transportEvents.push('cleanup-reconnected')
        }
        const fs = new FileOperations(sessions, async () => false).fs(cleanupId)
        assert.equal(await fs.realpath(root), root)
        await fs.remove(root)
        assert.equal(await fs.exists(root), null)
        report.remoteCleanup = true
        pass('Removed only the test-created remote folder and verified cleanup')
      } catch (error) {
        report.limited.push(`Temporary folder cleanup: ${mapError(error, 'cleanup').message}`)
      }
    }
    sessions.dispose()
    input.secret = ''
    if (local) {
      try {
        await removeTestDirectory(local, 'vps-server-smoke-')
        report.localCleanup = true
      } catch {
        report.limited.push('Local test directory cleanup could not be completed.')
      }
    }
    report.completedAt = new Date().toISOString()
  }
  return report
}
