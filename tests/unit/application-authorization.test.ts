import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../src/application/connection/session-manager'
import type { SettingsRepository } from '../../src/infrastructure/persistence/store'
import { ApplicationManager } from '../../src/application/applications/application-manager'
import { runAptRemoval } from '../../src/infrastructure/ssh/apt-transaction'
afterEach(() => vi.restoreAllMocks())
const inventory = (snapshot: string) =>
  '__UID__\n0\n__MANUAL__\nhello\n__HELD__\n\n__PACKAGES__\nhello\t1\tamd64\t1\tno\tno\toptional\tinstalled\tTest\nopenssh-server\t1\tamd64\t1\tno\tno\toptional\tinstalled\tSSH\n__SNAPSHOT__\n' +
  snapshot.repeat(64) +
  '  /var/lib/dpkg/status\n'
describe('removal plan authorization', () => {
  function fixture(removal = 'Remv hello [1]\n') {
    let hash = 'a'
    const exec = vi.fn(async (_id: string, command: string) =>
      command.includes('--simulate') ? removal : inventory(hash),
    )
    const confirm = vi.fn(async () => true)
    const manager = new ApplicationManager(
      { exec } as unknown as SessionManager,
      {} as SettingsRepository,
      confirm,
      () => {},
    )
    return {
      manager,
      confirm,
      change: () => {
        hash = 'b'
      },
    }
  }
  it('blocks protected dependent packages before any confirmation', async () => {
    const { manager, confirm } = fixture('Remv hello [1]\nRemv openssh-server [1]\n')
    const plan = await manager.prepare('session-a', 'package', 'hello')
    expect(plan.blocked.join(' ')).toContain('openssh-server')
    await expect(manager.execute('session-a', plan.token, 'none')).rejects.toThrow()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('rejects changed package database snapshots without executing removal', async () => {
    const { manager, change, confirm } = fixture()
    const plan = await manager.prepare('session-a', 'package', 'hello')
    change()
    await expect(manager.execute('session-a', plan.token, 'none')).rejects.toThrow(
      'database changed',
    )
    expect(confirm).not.toHaveBeenCalled()
  })
  it('rejects expired and foreign-session tokens', async () => {
    const { manager, confirm } = fixture()
    const plan = await manager.prepare('session-a', 'package', 'hello')
    await expect(manager.execute('session-b', plan.token, 'none')).rejects.toThrow(
      'another connection',
    )
    vi.spyOn(Date, 'now').mockReturnValue(plan.expiresAt + 1)
    await expect(manager.execute('session-a', plan.token, 'none')).rejects.toThrow('expired')
    expect(confirm).not.toHaveBeenCalled()
  })
})
describe('locked APT transaction approval', () => {
  function fixture(proposal: string) {
    const lifetime = new AbortController()
    const stream = Object.assign(new EventEmitter(), {
      stderr: { resume: vi.fn() },
      write: vi.fn((data: string) => {
        if (data === 'y\n') queueMicrotask(() => stream.emit('close', 0))
      }),
      end: vi.fn(() => queueMicrotask(() => stream.emit('close', 1))),
      close: vi.fn(() => queueMicrotask(() => stream.emit('close', 1))),
    })
    const live = {
      lifetime,
      channels: new Set(),
      client: {
        exec: (_command: string, callback: (error: null, value: typeof stream) => void) => {
          callback(null, stream)
          queueMicrotask(() => stream.emit('data', Buffer.from(proposal)))
        },
      },
    }
    return { stream, sessions: { get: () => live } as unknown as SessionManager }
  }
  const proposal = (name: string) =>
    `The following packages will be REMOVED:\n  ${name}\n0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.\nDo you want to continue? [Y/n] `
  it('never approves an unexpected actual proposal', async () => {
    const { sessions, stream } = fixture(proposal('different'))
    const confirm = vi.fn(async () => true)
    await expect(
      runAptRemoval(sessions, 'session', 'catalog command', ['hello'], confirm, () => {}),
    ).rejects.toThrow('differs')
    expect(confirm).not.toHaveBeenCalled()
    expect(stream.write).not.toHaveBeenCalled()
    expect(stream.end).toHaveBeenCalledWith('n\n')
  })
  it('sends no approval when the user cancels', async () => {
    const { sessions, stream } = fixture(proposal('hello'))
    expect(
      await runAptRemoval(
        sessions,
        'session',
        'catalog command',
        ['hello'],
        async () => false,
        () => {},
      ),
    ).toBe('cancelled')
    expect(stream.write).not.toHaveBeenCalled()
  })
  it('sends yes only after the exact plan is confirmed', async () => {
    const { sessions, stream } = fixture(proposal('hello'))
    const confirm = vi.fn(async () => true)
    expect(
      await runAptRemoval(sessions, 'session', 'catalog command', ['hello'], confirm, () => {}),
    ).toBe('completed')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(stream.write).toHaveBeenCalledWith('y\n')
  })
})
