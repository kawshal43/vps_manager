import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/application/connection/session-manager'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { ApplicationManager } from '../src/application/applications/application-manager'
import { FileOperations } from '../src/application/filesystem/file-operations'
import { removeTestDirectory } from './test-temp'

async function main(): Promise<void> {
  const config = JSON.parse(await readFile('.test-data/ubuntu/connection.json', 'utf8')) as {
    host: string
    port: number
    username: string
    keyPath: string
    fingerprint: string
  }
  // Actual removal tests are hard-bound to our disposable loopback fixture.
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 22222)
  assert.equal(config.username, 'vpstest')
  const local = await mkdtemp(join(tmpdir(), 'vps-app-test-'))
  const repository = new SettingsRepository(local)
  await repository.load()
  await repository.trust({
    host: config.host,
    port: config.port,
    fingerprint: config.fingerprint,
    keyType: 'ssh-ed25519',
    acceptedAt: new Date().toISOString(),
  })
  const sessions = new SessionManager(
    repository,
    { encrypt: async () => '', decrypt: async () => '' },
    (event) => {
      if (event.type === 'host-challenge') sessions.trust(event.challenge.id, false)
    },
  )
  let answer = false
  let confirmations = 0
  let root: string | undefined
  let count = 0
  const pass = (name: string): void => {
    count++
    process.stdout.write(`PASS ${name}\n`)
  }
  try {
    const session = await sessions.connect(
      {
        profile: {
          id: randomUUID(),
          displayName: 'Disposable package test',
          host: config.host,
          port: config.port,
          username: config.username,
          authenticationMethod: 'key',
        },
        rememberServer: false,
        rememberCredentials: false,
      },
      config.keyPath,
    )
    const deadline = Date.now() + 180000
    while (true) {
      try {
        await sessions.exec(session.id, 'test -f /home/vpstest/.vps-package-fixture-ready')
        break
      } catch {
        if (Date.now() > deadline) throw new Error('Package fixture provisioning timed out')
        process.stdout.write('Waiting for disposable package fixture…\n')
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
    const applications = new ApplicationManager(
      sessions,
      repository,
      async () => {
        confirmations++
        return answer
      },
      (event) => {
        if (event.type === 'application-operation')
          process.stdout.write(`  ${event.operation.stage}: ${event.operation.message}\n`)
      },
    )
    const fs = new FileOperations(sessions, async () => true).fs(session.id)
    const inventory = await applications.packages(session.id)
    assert.ok(inventory.packages.find((pkg) => pkg.name === 'hello'))
    assert.ok(inventory.packages.find((pkg) => pkg.name === 'openssh-server')?.protectedReason)
    pass('Actual installed package metadata, manual marks and core protection')
    const protectedPlan = await applications.prepare(session.id, 'package', 'openssh-server')
    assert.ok(protectedPlan.blocked.length)
    await assert.rejects(applications.execute(session.id, protectedPlan.token, 'sudo'))
    assert.equal(confirmations, 0)
    pass('SSH package removal blocked before execution and confirmation')
    const foreign = await applications.prepare(session.id, 'package', 'hello')
    await assert.rejects(
      applications.execute(randomUUID(), foreign.token, 'sudo'),
      /another connection/,
    )
    pass('Removal tokens cannot cross session identities')
    const denied = await applications.prepare(session.id, 'package', 'hello')
    await assert.rejects(
      applications.execute(session.id, denied.token, 'none'),
      /root authorization/,
    )
    pass('No silent sudo when the current account lacks root permissions')
    const cancelled = await applications.prepare(session.id, 'package', 'hello')
    const cancelResult = await applications.execute(session.id, cancelled.token, 'sudo')
    assert.equal(cancelResult.completed, false)
    assert.ok(
      (await applications.packages(session.id)).packages.find((pkg) => pkg.name === 'hello'),
    )
    await assert.rejects(applications.execute(session.id, cancelled.token, 'sudo'))
    pass('Real APT prompt cancellation preserves the package and consumes the token')
    answer = true
    const approved = await applications.prepare(session.id, 'package', 'hello')
    assert.deepEqual(
      approved.affected.map((pkg) => pkg.name),
      ['hello'],
    )
    const removed = await applications.execute(session.id, approved.token, 'sudo')
    assert.equal(removed.completed, true)
    assert.equal(
      (await applications.packages(session.id)).packages.some((pkg) => pkg.name === 'hello'),
      false,
    )
    pass('Explicit sudo APT removal and verified package absence on the disposable VM')
    await sessions.exec(
      session.id,
      'sudo -n -- /usr/bin/apt-get -o Dpkg::Use-Pty=0 install -y hello',
      90000,
    )
    assert.ok(
      (await applications.packages(session.id)).packages.find((pkg) => pkg.name === 'hello'),
    )
    pass('Restored the disposable hello test package')
    root = `${session.home}/.vps-app-test-${randomUUID()}`
    await fs.mkdir(root)
    await fs.save(`${root}/app.txt`, 'disposable app fixture', null)
    const record = await applications.saveDeployment(session.id, {
      name: 'Disposable app',
      path: root,
      notes: 'test',
    })
    assert.equal((await applications.deployments(session.id))[0].state, 'present')
    await applications.forgetDeployment(session.id, record.id)
    assert.ok(await fs.exists(root))
    assert.equal(repository.deployments().length, 0)
    pass('Removing a saved entry preserves the real deployment files')
    const second = await applications.saveDeployment(session.id, {
      name: 'Remove test files',
      path: root,
      notes: '',
    })
    const stale = await applications.prepare(session.id, 'deployment', second.id)
    await fs.save(`${root}/changed.txt`, 'changed after preview', null)
    await assert.rejects(applications.execute(session.id, stale.token, 'none'), /files changed/)
    assert.ok(await fs.exists(root))
    pass('Stale deployment previews cannot delete changed directories')
    const manual = await applications.prepare(session.id, 'deployment', second.id)
    assert.equal((await applications.execute(session.id, manual.token, 'none')).completed, true)
    assert.equal(await fs.exists(root), null)
    root = undefined
    pass('Confirmed deployment-file removal and local-entry cleanup')
    root = `${session.home}/.vps-app-test-${randomUUID()}`
    await fs.mkdir(root)
    await fs.save(`${root}/app.txt`, 'linked fixture', null)
    const linked = await applications.saveDeployment(session.id, {
      name: 'Linked fixture',
      path: root,
      service: 'vps-manager-test.service',
      notes: '',
    })
    const linkedPlan = await applications.prepare(session.id, 'deployment', linked.id)
    assert.equal((await applications.execute(session.id, linkedPlan.token, 'sudo')).completed, true)
    assert.equal(await fs.exists(root), null)
    assert.ok(await fs.exists('/etc/systemd/system/vps-manager-test.service'))
    root = undefined
    pass('Explicit service stop/disable plus deployment deletion, retaining the unit definition')
    process.stdout.write(`\n${count} real disposable application-management checks passed.\n`)
  } finally {
    if (root) {
      const session = sessions.list().find((value) => value.state === 'CONNECTED')
      if (session)
        await new FileOperations(sessions, async () => true)
          .fs(session.id)
          .remove(root)
          .catch(() => {})
    }
    sessions.dispose()
    await removeTestDirectory(local, 'vps-app-test-')
  }
}
void main().catch((error) => {
  process.stderr.write(
    `FAIL ${error instanceof Error ? error.message : 'Application acceptance failed'}\n`,
  )
  process.exitCode = 1
})
