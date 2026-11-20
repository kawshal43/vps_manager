import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { removeTestDirectory } from './test-temp'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { SessionManager } from '../src/main/session/session-manager'
import { RemoteFs } from '../src/infrastructure/sftp/remote-fs'
import { FileOperations } from '../src/application/filesystem/file-operations'
import { TransferManager } from '../src/application/transfers/transfer-manager'
import { Monitoring } from '../src/application/monitoring/monitoring'
import { TerminalManager } from '../src/application/terminal/terminal-manager'
import { quotePosix } from '../src/domain/filesystem/policy'
import { serviceActionCommand, servicesCommand } from '../src/infrastructure/commands/catalog'
import type { AppEvent } from '../src/shared/contracts/api'
import type { ServerProfile } from '../src/domain/connection/types'

export async function ubuntuAcceptance(
  configPath = process.env.VPS_TEST_CONFIG || '.test-data/ubuntu/connection.json',
): Promise<string[]> {
  if (process.env.VPS_TEST_CONFIG && process.env.VPS_TEST_ALLOW_DISPOSABLE !== '1')
    throw new Error('Set VPS_TEST_ALLOW_DISPOSABLE=1 only for a disposable Ubuntu server.')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    host: string
    port: number
    username: string
    password?: string
    keyPath: string
    fingerprint: string
  }
  assert.ok(
    config.fingerprint.startsWith('SHA256:'),
    'An independently verified fingerprint is required',
  )
  const local = await mkdtemp(join(tmpdir(), 'vps-acceptance-'))
  const completed: string[] = []
  const pass = (name: string) => {
    completed.push(name)
    process.stdout.write(`PASS ${name}\n`)
  }
  const repo = new SettingsRepository(join(local, 'settings'))
  await repo.load()
  const events: AppEvent[] = []
  const vault = {
    encrypt: async () => {
      throw new Error('Vault is not used by this integration test')
    },
    decrypt: async () => {
      throw new Error('Vault is not used by this integration test')
    },
  }
  const profile: ServerProfile = {
    id: randomUUID(),
    displayName: 'Disposable acceptance',
    host: config.host,
    port: config.port,
    username: config.username,
    authenticationMethod: 'key',
  }
  const manager = new SessionManager(repo, vault, (event) => {
    events.push(event)
    if (event.type === 'host-challenge')
      manager.trust(event.challenge.id, event.challenge.fingerprint === config.fingerprint)
  })
  let root: string | undefined
  let transfers: TransferManager | undefined
  try {
    const info = await manager.connect(
      { profile, rememberServer: false, rememberCredentials: false },
      config.keyPath,
    )
    assert.equal(info.state, 'CONNECTED')
    assert.equal(info.sftp, true)
    assert.match(info.distribution, /Ubuntu/)
    pass('Verified Ubuntu identity, key authentication, and SFTP')
    const fs = new RemoteFs(manager.fs(info.id))
    root = `${info.home}/.vps-manager-acceptance-${randomUUID()}`
    await fs.mkdir(root)
    assert.equal((await fs.list(root)).entries.length, 0)
    pass('Created and listed isolated remote directory')
    const doc = await fs.save(`${root}/config.json`, '{"version":1}\n', null)
    const next = await fs.save(doc.path, '{"version":2}\n', doc.identity)
    assert.equal(next.content, '{"version":2}\n')
    await assert.rejects(fs.save(doc.path, 'stale', doc.identity), /changed/)
    pass('Atomic editor save and stale-content conflict detection')
    await fs.rename(doc.path, `${root}/renamed.json`)
    assert.ok(await fs.exists(`${root}/renamed.json`))
    const operations = new FileOperations(manager, async () => true)
    await fs.mkdir(`${root}/copies`)
    await operations.copy(info.id, [`${root}/renamed.json`], `${root}/copies`)
    assert.equal((await fs.text(`${root}/copies/renamed.json`)).content, next.content)
    pass('Rename and verified server-side copy')
    const malicious = `${root}/quote' ;$(echo no).txt`
    await fs.save(malicious, 'safe', null)
    await operations.copy(info.id, [malicious], `${root}/copies`)
    assert.equal((await fs.text(`${root}/copies/quote' ;$(echo no).txt`)).content, 'safe')
    pass('Shell metacharacters treated as literal filename data')
    await fs.chmod(`${root}/renamed.json`, 0o600)
    assert.equal((await fs.lstat(`${root}/renamed.json`)).mode & 0o777, 0o600)
    await assert.rejects(fs.mkdir('/etc/vps-manager-not-authorized'))
    await assert.rejects(fs.remove('/'))
    await assert.rejects(fs.mutationPath('/etc/ssh/sshd_config'))
    pass('Account permission failures and protected system paths')
    await manager.exec(
      info.id,
      `ln -s -- ${quotePosix(`${root}/copies`)} ${quotePosix(`${root}/linked`)}`,
    )
    await fs.remove(`${root}/linked`)
    assert.ok(await fs.exists(`${root}/copies/renamed.json`))
    pass('Symlink deletion does not follow its target')
    await fs.writeAtomic(`${root}/binary.bin`, Readable.from([Buffer.from([0, 1, 2])]), 3, null)
    await assert.rejects(fs.text(`${root}/binary.bin`), /binary/)
    pass('Binary file editor rejection')
    const upload = join(local, 'project')
    await mkdir(join(upload, 'nested'), { recursive: true })
    await writeFile(join(upload, 'nested', 'large.dat'), Buffer.alloc(4 * 1024 * 1024, 65))
    await writeFile(join(upload, 'readme.txt'), 'recursive upload\n')
    const download = join(local, 'downloads')
    await mkdir(download)
    transfers = new TransferManager(
      manager,
      (event) => events.push(event),
      async () => ({ policy: 'replace', all: true }),
    )
    const wait = async () => {
      const deadline = Date.now() + 90000
      while (
        transfers!.list().some((j) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status))
      ) {
        if (Date.now() > deadline) throw new Error('Transfer timeout')
        await new Promise((r) => setTimeout(r, 50))
      }
      const failures = transfers!.list().filter((j) => j.status === 'FAILED')
      assert.deepEqual(
        failures.map((j) => j.error),
        [],
      )
    }
    await transfers.upload(info.id, [upload], root, 'ask')
    await wait()
    assert.equal((await fs.lstat(`${root}/project/nested/large.dat`)).size, 4194304)
    await transfers.download(info.id, [`${root}/project`], download, 'ask')
    await wait()
    assert.equal(
      await readFile(join(download, 'project', 'readme.txt'), 'utf8'),
      'recursive upload\n',
    )
    assert.equal((await readFile(join(download, 'project', 'nested', 'large.dat'))).length, 4194304)
    pass('Recursive streaming uploads and downloads with confirmed byte counts')
    await writeFile(join(upload, 'readme.txt'), 'replacement\n')
    await transfers.upload(info.id, [join(upload, 'readme.txt')], `${root}/project`, 'replace')
    await wait()
    assert.equal((await fs.text(`${root}/project/readme.txt`)).content, 'replacement\n')
    pass('Safe transfer replacement')
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(
      fs.writeAtomic(
        `${root}/cancelled.txt`,
        Readable.from(['cancelled']),
        9,
        null,
        cancelled.signal,
      ),
    )
    assert.equal(await fs.exists(`${root}/cancelled.txt`), null)
    pass('Cancelled upload does not publish a final file')
    const midflight = new AbortController()
    const slowSource = () =>
      Readable.from(
        (async function* () {
          for (let n = 0; n < 128; n++) {
            await new Promise((r) => setTimeout(r, 2))
            yield Buffer.alloc(65536, 66)
          }
        })(),
      )
    await assert.rejects(
      fs.writeAtomic(
        `${root}/midflight.bin`,
        slowSource(),
        8388608,
        null,
        midflight.signal,
        (count) => {
          if (count >= 131072) midflight.abort()
        },
      ),
    )
    assert.equal(await fs.exists(`${root}/midflight.bin`), null)
    assert.equal(
      (await fs.list(root)).entries.some((f) => f.name.endsWith('.part')),
      false,
    )
    pass('Mid-transfer cancellation removes temporary data')
    const secondSession = await manager.connect(
      {
        profile: { ...profile, id: randomUUID() },
        rememberServer: false,
        rememberCredentials: false,
      },
      config.keyPath,
    )
    const disconnectedFs = new RemoteFs(manager.fs(secondSession.id))
    const original = await fs.save(`${root}/interrupted.txt`, 'preserved original', null)
    await assert.rejects(
      disconnectedFs.writeAtomic(
        original.path,
        slowSource(),
        8388608,
        original.identity,
        undefined,
        (count) => {
          if (count >= 131072) manager.disconnect(secondSession.id)
        },
      ),
    )
    assert.equal((await fs.text(original.path)).content, 'preserved original')
    pass('Lost SSH connection preserves the original replacement target')
    let decisions = 0
    transfers = new TransferManager(
      manager,
      (event) => events.push(event),
      async () => {
        decisions++
        return { policy: 'skip', all: true }
      },
    )
    await transfers.upload(
      info.id,
      [join(upload, 'readme.txt'), join(upload, 'nested', 'large.dat')],
      `${root}/project`,
      'ask',
    )
    await wait()
    // The second filename is new in this directory; create a second conflict and retry the batch.
    await transfers.upload(
      info.id,
      [join(upload, 'readme.txt'), join(upload, 'nested', 'large.dat')],
      `${root}/project`,
      'ask',
    )
    await wait()
    assert.equal(decisions, 2)
    assert.ok(transfers.list().filter((j) => j.status === 'CANCELLED').length >= 3)
    pass('Apply-to-all conflicts are serialized and scoped to a transfer batch')
    const monitoring = new Monitoring(manager)
    const metrics = await monitoring.get(info.id)
    assert.ok(metrics.memoryTotal > 0)
    assert.ok(metrics.diskTotal > 0)
    assert.ok(metrics.cpuCount > 0)
    pass('Actual /proc and filesystem monitoring')
    assert.match(await manager.exec(info.id, servicesCommand), /ssh/)
    await assert.rejects(
      manager.exec(info.id, serviceActionCommand('vps-manager-test.service', 'restart')),
    )
    pass('Real systemd discovery and unprivileged service-action denial')
    let terminalOutput = ''
    const terminals = new TerminalManager(manager, (event) => {
      if (event.type === 'terminal-data') {
        terminalOutput += event.data
        if (terminalId) terminals.ack(terminalId, event.bytes)
      }
    })
    const terminalId = await terminals.open(info.id, 80, 24, root)
    terminals.ack(terminalId, 0)
    terminals.input(terminalId, "printf 'VPS_TERMINAL_%s\\n' VERIFIED\n")
    const deadline = Date.now() + 10000
    while (!terminalOutput.includes('VPS_TERMINAL_VERIFIED')) {
      if (Date.now() > deadline) throw new Error('Interactive terminal did not return output')
      await new Promise((r) => setTimeout(r, 50))
    }
    terminals.resize(terminalId, 100, 30)
    terminals.close(terminalId)
    pass('Interactive PTY input, output, resize, and close')
    if (config.password) {
      const passwordSession = await manager.connect({
        profile: { ...profile, id: randomUUID(), authenticationMethod: 'password' },
        secret: config.password,
        rememberServer: false,
        rememberCredentials: false,
      })
      manager.disconnect(passwordSession.id)
      pass('Password authentication against the same verified host')
      await assert.rejects(
        manager.connect({
          profile: { ...profile, id: randomUUID(), authenticationMethod: 'password' },
          secret: 'intentionally-invalid-test-password',
          rememberServer: false,
          rememberCredentials: false,
        }),
      )
      pass('Authentication failure is not reported as connected')
    }
    const mismatchRepo = new SettingsRepository(join(local, 'mismatch'))
    await mismatchRepo.load()
    await mismatchRepo.trust({
      host: config.host,
      port: config.port,
      fingerprint: 'SHA256:deliberately-incorrect',
      keyType: 'ssh-ed25519',
      acceptedAt: new Date().toISOString(),
    })
    const mismatch = new SessionManager(mismatchRepo, vault, () => {})
    try {
      await assert.rejects(
        mismatch.connect(
          { profile, rememberServer: false, rememberCredentials: false },
          config.keyPath,
        ),
        /host key has changed/,
      )
      pass('Changed host key rejected before authentication')
    } finally {
      mismatch.dispose()
    }
    await fs.remove(root)
    root = undefined
    manager.disconnect(info.id)
    assert.throws(() => manager.get(info.id), /disconnected/)
    pass('Recursive cleanup, disconnect, and closed-session rejection')
    return completed
  } finally {
    transfers?.cancelAll()
    if (root) {
      const live = manager.list().find((s) => s.state === 'CONNECTED')
      if (live) await new RemoteFs(manager.fs(live.id)).remove(root).catch(() => {})
    }
    manager.dispose()
    await removeTestDirectory(local, 'vps-acceptance-')
  }
}
if (process.argv[1]?.endsWith('ubuntu-acceptance.ts'))
  ubuntuAcceptance().then(
    (results) => process.stdout.write(`\n${results.length} Ubuntu integration checks passed.\n`),
    (error) => {
      process.stderr.write(
        `FAIL ${error instanceof Error ? error.message : 'Integration failure'}\n`,
      )
      process.exitCode = 1
    },
  )
