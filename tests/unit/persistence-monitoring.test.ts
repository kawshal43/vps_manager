import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { removeTestDirectory } from '../../scripts/test-temp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SettingsRepository } from '../../src/infrastructure/persistence/store'
import { parseMetrics } from '../../src/application/monitoring/monitoring'
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTestDirectory(directory, 'vps-test-')
})
describe('versioned persistence', () => {
  it('migrates v1 without losing host trust, profiles or encrypted secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vps-test-'))
    directories.push(dir)
    const source = new SettingsRepository(dir)
    await source.load()
    const profile = {
      id: randomUUID(),
      displayName: 'Saved server',
      host: 'localhost',
      port: 22,
      username: 'test',
      authenticationMethod: 'password' as const,
    }
    await source.saveProfile(profile)
    await source.saveCredential(profile.id, 'CIPHERTEXT')
    await source.trust({
      host: 'localhost',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture',
      acceptedAt: new Date().toISOString(),
    })
    const old = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    old.version = 1
    delete old.deployments
    await writeFile(join(dir, 'settings.json'), JSON.stringify(old))
    const migrated = new SettingsRepository(dir)
    await migrated.load()
    expect(migrated.profiles()[0].id).toBe(profile.id)
    expect(migrated.credential(profile.id)).toBe('CIPHERTEXT')
    expect(migrated.hosts()[0].fingerprint).toBe('SHA256:fixture')
    expect(migrated.deployments()).toEqual([])
    await migrated.flush()
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).version).toBe(2)
  })
  it('serializes atomic writes and keeps credentials out of profile fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vps-test-'))
    directories.push(dir)
    const repo = new SettingsRepository(dir)
    await repo.load()
    const id = randomUUID()
    await repo.saveProfile({
      id,
      displayName: 'Test',
      host: 'localhost',
      port: 22,
      username: 'test',
      authenticationMethod: 'password',
      hasCredential: false,
    })
    await Promise.all([
      repo.updatePreferences({ ...repo.preferences(), theme: 'dark' }),
      repo.saveCredential(id, 'OS_ENCRYPTED_BLOB'),
    ])
    const second = new SettingsRepository(dir)
    await second.load()
    expect(second.preferences().theme).toBe('dark')
    expect(second.profiles()[0].hasCredential).toBe(true)
    const disk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(disk.profiles[0]).not.toHaveProperty('password')
    expect(disk.version).toBe(2)
    await second.removeProfile(id)
    expect(second.credential(id)).toBeUndefined()
  })
  it('preserves corrupted settings instead of overwriting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vps-test-'))
    directories.push(dir)
    await writeFile(join(dir, 'settings.json'), '{broken')
    await expect(new SettingsRepository(dir).load()).rejects.toThrow('invalid')
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{broken')
  })
})
describe('Linux monitoring', () => {
  const raw =
    'cpu  100 0 100 800 0 0 0 0 0 0\n2\nMemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n\n__DISK__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000 3000 7000 30% /\n__UPTIME__\n100.00 200.00\n0.10 0.20 0.30 1/100 123\n'
  it('uses MemAvailable and samples CPU deltas', () => {
    const first = parseMetrics(raw)
    expect(first.metrics.cpuPercent).toBeNull()
    expect(first.metrics.memoryAvailable).toBe(409600)
    expect(first.metrics.diskUsed).toBe(3072000)
    expect(parseMetrics(raw, { total: 800, idle: 700 }).metrics.cpuPercent).toBe(50)
  })
  it('rejects incomplete output', () => expect(() => parseMetrics('unexpected')).toThrow())
})
