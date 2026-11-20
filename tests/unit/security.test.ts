import { describe, expect, it } from 'vitest'
import { AppError, mapError } from '../../src/domain/errors/app-error'
import {
  assertMutable,
  quotePosix,
  validateName,
  validatePath,
  validateWindowsName,
} from '../../src/domain/filesystem/policy'
import { transition } from '../../src/domain/connection/state'
import { schemas, host } from '../../src/shared/schemas'
import { serviceActionCommand } from '../../src/infrastructure/commands/catalog'
import { sameIdentity } from '../../src/infrastructure/sftp/remote-fs'
describe('remote path security', () => {
  it('normalizes POSIX paths on Windows', () => {
    expect(validatePath('/home/test/./project/../file')).toBe('/home/test/file')
    expect(validatePath('//home//ubuntu/')).toBe('/home/ubuntu')
  })
  it.each(['relative', '/a\0b', '/a\nb'])('rejects invalid paths: %j', (p) =>
    expect(() => validatePath(p)).toThrow(AppError),
  )
  it.each([
    '/',
    '/etc',
    '/usr/bin/sh',
    '/boot/grub',
    '/home/user/.ssh/authorized_keys',
    '/etc/ssh/sshd_config',
    '/etc/../etc/shadow',
  ])('blocks protected mutation: %s', (p) => expect(() => assertMutable(p)).toThrow(AppError))
  it('allows ordinary user files', () =>
    expect(() => assertMutable('/home/ubuntu/project/.env')).not.toThrow())
  it.each(['', '.', '..', '../file', 'a/b', 'a\nb'])('rejects unsafe names: %j', (n) =>
    expect(() => validateName(n)).toThrow(),
  )
  it('accepts punctuation without shell interpretation', () =>
    expect(validateName("x;$(touch harmless)' file")).toBe("x;$(touch harmless)' file"))
  it('quotes shell metacharacters as one argument', () =>
    expect(quotePosix("a'b;$(id)")).toBe("'a'\\''b;$(id)'"))
  it.each(['CON', 'nul.txt', 'COM1.log', 'a:b', 'a\\b', '..', 'trail.', 'trail '])(
    'rejects invalid Windows names: %s',
    (n) => expect(() => validateWindowsName(n)).toThrow(),
  )
})
describe('IPC and SSH policies', () => {
  it.each(['127.0.0.1', '2001:db8::1', '::1', 'server.example.com', 'localhost'])(
    'accepts valid server addresses: %s',
    (value) => expect(host.safeParse(value).success).toBe(true),
  )
  it.each(['999.1.1.1', '::::', 'ssh://host', 'user@host', '-host', 'bad host', 'a..b', 'a/b'])(
    'rejects invalid server addresses: %s',
    (value) => expect(host.safeParse(value).success).toBe(false),
  )
  it('rejects invalid ports and extra capabilities', () => {
    expect(
      schemas['terminal.open'].safeParse({ sessionId: 'not-an-id', cols: 80, rows: 24 }).success,
    ).toBe(false)
    expect(schemas['app.bootstrap'].safeParse({ command: 'id' }).success).toBe(false)
  })
  it('rejects arbitrary service actions and injected identifiers', () => {
    expect(() => serviceActionCommand('ssh.service; reboot', 'restart')).toThrow()
    expect(serviceActionCommand('nginx.service', 'restart')).toBe(
      "LC_ALL=C systemctl --no-ask-password restart -- 'nginx.service'",
    )
  })
  it('requires authentication before connected state', () => {
    expect(() => transition('CONNECTING', 'CONNECTED')).toThrow()
    expect(transition('AUTHENTICATING', 'INITIALIZING_SESSION')).toBe('INITIALIZING_SESSION')
  })
  it('maps errors without leaking the original message', () => {
    const error = Object.assign(new Error('SECRET_PASSWORD'), { level: 'client-authentication' })
    const mapped = mapError(error, 'connection.connect')
    expect(mapped.code).toBe('SSH_AUTH_ERROR')
    expect(JSON.stringify(mapped)).not.toContain('SECRET')
  })
  it('detects remote file identity changes', () => {
    const base = { size: 10, mtime: 1, mode: 0o644, uid: 1000, gid: 1000 }
    expect(sameIdentity(base, { ...base })).toBe(true)
    expect(sameIdentity(base, { ...base, mtime: 2 })).toBe(false)
  })
})
