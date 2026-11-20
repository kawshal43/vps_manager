import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../src/application/connection/session-manager'
import { TerminalManager } from '../../src/application/terminal/terminal-manager'

describe('terminal channel lifecycle', () => {
  it('closes the shell channel without injecting commands or ending the SSH transport', async () => {
    const channel = Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    })
    const transport = {
      shell: vi.fn((_options, callback) => callback(null, channel)),
      end: vi.fn(),
      destroy: vi.fn(),
    }
    const live = { client: transport, channels: new Set() }
    const sessions = { get: () => live } as unknown as SessionManager
    const terminal = new TerminalManager(sessions, () => {})
    const id = await terminal.open('test-session', 80, 24)
    terminal.close(id)
    terminal.close(id)
    expect(() => terminal.ack(id, 32)).not.toThrow()
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(channel.write).not.toHaveBeenCalled()
    expect(channel.end).not.toHaveBeenCalled()
    expect(channel.destroy).not.toHaveBeenCalled()
    expect(transport.end).not.toHaveBeenCalled()
    expect(transport.destroy).not.toHaveBeenCalled()
    channel.emit('close')
    expect(live.channels.size).toBe(0)
  })
})
