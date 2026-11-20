import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '../../src/application/connection/session-manager'
import type { SettingsRepository } from '../../src/infrastructure/persistence/store'

function fixture() {
  const stderr = Object.assign(new EventEmitter(), { resume: vi.fn() })
  const channel = Object.assign(new EventEmitter(), { stderr, destroy: vi.fn(), signal: vi.fn() })
  const manager = new SessionManager(
    {} as SettingsRepository,
    { encrypt: async () => '', decrypt: async () => '' },
    () => {},
  )
  vi.spyOn(manager, 'get').mockReturnValue({
    channels: new Set(),
    client: {
      exec: (_command: string, callback: (e: null, channel: unknown) => void) =>
        callback(null, channel),
    },
  } as unknown as ReturnType<SessionManager['get']>)
  return { manager, channel, stderr }
}
describe('bounded authenticated deployment command streams', () => {
  it('preserves UTF-8 split across SSH packets on stdout and stderr', async () => {
    const { manager, channel, stderr } = fixture(),
      lines: string[] = []
    const pending = manager.exec('session', 'fixed catalog command', 1000, undefined, (text) =>
      lines.push(text),
    )
    const output = Buffer.from('build 🐱 complete')
    channel.emit('data', output.subarray(0, 8))
    channel.emit('data', output.subarray(8))
    const warning = Buffer.from(' · café')
    stderr.emit('data', warning.subarray(0, warning.length - 1))
    stderr.emit('data', warning.subarray(warning.length - 1))
    channel.emit('close', 0)
    await pending
    expect(lines.join('')).toBe('build 🐱 complete · café')
  })
  it('applies the output bound to stderr and stops the command before returning an error', async () => {
    const { manager, channel, stderr } = fixture()
    const pending = manager.exec('session', 'fixed catalog command', 1000, undefined, () => {})
    const rejected = expect(pending).rejects.toThrow(/output exceeded/)
    stderr.emit('data', Buffer.alloc(16 * 1024 ** 2 + 1))
    await rejected
    expect(channel.destroy).toHaveBeenCalledTimes(1)
  })
})
