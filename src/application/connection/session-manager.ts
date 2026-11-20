import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { Client, utils, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { AppEvent } from '../../shared/contracts/api'
import type { ConnectionState, HostChallenge, ServerSession } from '../../domain/connection/types'
import { AppError, mapError } from '../../domain/errors/app-error'
import { transition } from '../../domain/connection/state'
import type { Input } from '../../shared/schemas'
import type { SettingsRepository } from '../../infrastructure/persistence/store'
import { discoveryCommand } from '../../infrastructure/commands/catalog'
import { bindSftpLifetime } from '../../infrastructure/sftp/remote-fs'
import type { CredentialVault } from '../../infrastructure/credentials/vault'

export interface LiveSession {
  lifetime: AbortController
  info: ServerSession
  client: Client
  sftp?: SFTPWrapper
  channels: Set<ClientChannel>
}
interface PendingTrust {
  challenge: HostChallenge
  resolve: (accepted: boolean) => void
}
export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  private pending = new Map<string, PendingTrust>()
  private connecting = new Set<string>()
  constructor(
    private repository: SettingsRepository,
    private vault: Pick<CredentialVault, 'encrypt' | 'decrypt'>,
    private emit: (event: AppEvent) => void,
  ) {}
  list(): ServerSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }
  get(id: string): LiveSession {
    const session = this.sessions.get(id)
    if (!session || session.info.state !== 'CONNECTED')
      throw new AppError(
        'NETWORK_ERROR',
        'This server is disconnected.',
        'Reconnect before retrying.',
        true,
      )
    return session
  }
  fs(id: string): SFTPWrapper {
    const sftp = this.get(id).sftp
    if (!sftp)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'This server does not provide SFTP.',
        'Use Terminal or enable the SFTP subsystem on the server.',
      )
    return sftp
  }
  private state(s: LiveSession, state: ConnectionState): void {
    s.info.state = transition(s.info.state, state)
    this.emit({ type: 'session', session: { ...s.info } })
  }
  async connect(input: Input<'connection.connect'>, selectedKey?: string): Promise<ServerSession> {
    const terminalStates = ['DISCONNECTED', 'CONNECTION_FAILED', 'AUTHENTICATION_FAILED']
    if (
      [...this.sessions.values()].filter((s) => !terminalStates.includes(s.info.state)).length >= 8
    )
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Eight server sessions are already open.',
        'Disconnect an existing session before adding another.',
      )
    if (this.sessions.size >= 32)
      for (const [oldId, previous] of this.sessions) {
        if (terminalStates.includes(previous.info.state)) {
          this.sessions.delete(oldId)
          if (this.sessions.size < 32) break
        }
      }
    const id = randomUUID()
    const client = new Client()
    const info: ServerSession = {
      id,
      profile: { ...input.profile },
      state: 'DISCONNECTED',
      home: '/',
      hostname: '',
      distribution: '',
      architecture: '',
      sftp: false,
    }
    const s: LiveSession = { info, client, channels: new Set(), lifetime: new AbortController() }
    this.sessions.set(id, s)
    this.connecting.add(id)
    this.state(s, 'VALIDATING')
    let secret = input.secret
    let privateKey: Buffer | undefined
    let hostError: AppError | undefined
    try {
      const saved = this.repository.profiles().find((p) => p.id === input.profile.id)
      if (
        secret === undefined &&
        saved &&
        saved.host === input.profile.host &&
        saved.port === input.profile.port &&
        saved.username === input.profile.username &&
        saved.authenticationMethod === input.profile.authenticationMethod
      ) {
        const stored = this.repository.credential(saved.id)
        if (stored) secret = await this.vault.decrypt(stored)
      }
      if (input.rememberCredentials && !input.rememberServer)
        throw new AppError(
          'INVALID_REQUEST',
          'Save the server profile before remembering its credentials.',
        )
      let keyPath: string | undefined
      if (input.profile.authenticationMethod === 'key') {
        keyPath =
          selectedKey ??
          (saved?.privateKeyReference === input.profile.privateKeyReference
            ? saved?.privateKeyReference
            : undefined)
        if (!keyPath)
          throw new AppError('INVALID_REQUEST', 'Select an SSH private key using the file picker.')
        if ((await stat(keyPath)).size > 1024 * 1024)
          throw new AppError('INVALID_REQUEST', 'The selected private key is too large.')
        privateKey = await readFile(keyPath)
        const parsed = utils.parseKey(privateKey, secret || undefined)
        if (parsed instanceof Error)
          throw new AppError(
            'SSH_AUTH_ERROR',
            'The private key could not be opened.',
            'Check the selected key and passphrase.',
          )
        info.profile.privateKeyReference = keyPath
      } else if (!secret) throw new AppError('INVALID_REQUEST', 'Enter an SSH password.')
      if (info.state !== 'VALIDATING') throw new AppError('CANCELLED', 'Connection cancelled.')
      this.state(s, 'CONNECTING')
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const fail = (error: Error): void => {
          if (!settled) {
            settled = true
            reject(hostError ?? error)
          }
        }
        client.on('error', fail)
        client.once('close', () => {
          s.lifetime.abort()
          if (!settled)
            fail(new AppError('NETWORK_ERROR', 'The SSH connection closed before initialization.'))
          if (info.state === 'CONNECTED') {
            info.warning =
              'Connection lost. In-flight operation results may be uncertain. Reconnect explicitly; destructive operations are never replayed.'
            this.state(s, 'CONNECTION_LOST')
          }
          for (const pending of this.pending.values())
            if (pending.challenge.sessionId === id) pending.resolve(false)
        })
        client.once('ready', () => {
          if (settled) return
          settled = true
          resolve()
        })
        client.connect({
          host: input.profile.host.toLowerCase(),
          port: input.profile.port,
          username: input.profile.username,
          password: privateKey ? undefined : secret,
          privateKey,
          passphrase: privateKey ? secret : undefined,
          readyTimeout: 150000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
            void (async () => {
              const fingerprint =
                'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
              const parsed = utils.parseKey(key)
              const keyType =
                parsed instanceof Error
                  ? 'unknown'
                  : Array.isArray(parsed)
                    ? parsed[0].type
                    : parsed.type
              const host = input.profile.host.toLowerCase()
              const trusted = this.repository
                .hosts()
                .filter((h) => h.host === host && h.port === input.profile.port)
              if (trusted.length) {
                if (trusted.at(-1)?.fingerprint !== fingerprint) {
                  hostError = new AppError(
                    'HOST_KEY_ERROR',
                    'The SSH host key has changed. Connection blocked.',
                    'Verify the new fingerprint with your server provider. Resolve the trusted key change deliberately; it is never accepted automatically.',
                  )
                  callback(false)
                  return
                }
              } else {
                this.state(s, 'VERIFYING_HOST_KEY')
                const challenge: HostChallenge = {
                  id: randomUUID(),
                  sessionId: id,
                  host,
                  port: input.profile.port,
                  fingerprint,
                  keyType,
                }
                const accepted = await new Promise<boolean>((resolveTrust) => {
                  const timer = setTimeout(() => {
                    this.pending.delete(challenge.id)
                    resolveTrust(false)
                  }, 120000)
                  this.pending.set(challenge.id, {
                    challenge,
                    resolve: (value) => {
                      clearTimeout(timer)
                      this.pending.delete(challenge.id)
                      resolveTrust(value)
                    },
                  })
                  this.emit({ type: 'host-challenge', challenge })
                })
                if (!accepted || info.state === 'DISCONNECTED' || info.state === 'DISCONNECTING') {
                  hostError = new AppError('HOST_KEY_ERROR', 'The SSH host key was not accepted.')
                  callback(false)
                  return
                }
                await this.repository.trust({
                  host,
                  port: input.profile.port,
                  fingerprint,
                  keyType,
                  acceptedAt: new Date().toISOString(),
                })
              }
              this.state(s, 'AUTHENTICATING')
              callback(true)
            })().catch(() => {
              hostError = new AppError('HOST_KEY_ERROR', 'Host-key verification failed.')
              callback(false)
            })
          },
        })
      })
      this.state(s, 'INITIALIZING_SESSION')
      const discovery = await this.execLive(s, discoveryCommand)
      const lines = discovery.trimEnd().split(/\r?\n/)
      if (!lines[0]?.startsWith('/'))
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The server did not return a valid Linux home directory.',
        )
      info.home = lines[0]
      info.hostname = lines[1] || input.profile.host
      info.architecture = lines[2] || ''
      info.distribution = lines.slice(3).join(' ')
      try {
        s.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new AppError('OPERATION_TIMEOUT', 'SFTP initialization timed out.')),
            15000,
          )
          client.sftp((e, fs) => {
            clearTimeout(timer)
            if (e) reject(e)
            else resolve(fs)
          })
        })
        info.sftp = true
        bindSftpLifetime(s.sftp, s.lifetime.signal)
        s.sftp.on('error', () => {
          info.sftp = false
          s.sftp = undefined
          info.warning = 'The SFTP channel closed. Reconnect to restore file management.'
          this.emit({ type: 'session', session: { ...info } })
        })
      } catch {
        info.warning = 'SFTP is unavailable. Terminal and monitoring remain available.'
      }
      info.profile.lastConnectedAt = new Date().toISOString()
      if (input.rememberServer) {
        await this.repository.saveProfile(info.profile)
        if (input.rememberCredentials && secret !== undefined)
          await this.repository.saveCredential(info.profile.id, await this.vault.encrypt(secret))
        await this.repository.updatePreferences({
          ...this.repository.preferences(),
          lastProfileId: info.profile.id,
        })
      }
      this.state(s, 'CONNECTED')
      return { ...info }
    } catch (error) {
      if (!['DISCONNECTING', 'DISCONNECTED'].includes(info.state))
        this.state(
          s,
          info.state === 'AUTHENTICATING' && mapError(error, 'connect').code === 'SSH_AUTH_ERROR'
            ? 'AUTHENTICATION_FAILED'
            : 'CONNECTION_FAILED',
        )
      client.end()
      throw error
    } finally {
      secret = undefined
      privateKey?.fill(0)
      this.connecting.delete(id)
    }
  }
  trust(id: string, accepted: boolean): void {
    const p = this.pending.get(id)
    if (!p) throw new AppError('INVALID_REQUEST', 'This host-key verification has expired.')
    p.resolve(accepted)
  }
  cancel(): void {
    for (const id of this.connecting) this.disconnect(id)
  }
  disconnect(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.info.state === 'DISCONNECTED') return
    this.state(s, 'DISCONNECTING')
    s.lifetime.abort()
    for (const p of this.pending.values()) if (p.challenge.sessionId === id) p.resolve(false)
    for (const channel of s.channels) channel.destroy()
    s.sftp?.end()
    s.client.destroy()
    this.state(s, 'DISCONNECTED')
  }
  dispose(): void {
    for (const id of this.sessions.keys()) this.disconnect(id)
  }
  exec(id: string, command: string, timeout = 15000, signal?: AbortSignal): Promise<string> {
    return this.execLive(this.get(id), command, timeout, signal)
  }
  private execLive(
    s: LiveSession,
    command: string,
    timeout = 15000,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined
      let finished = false
      const finish = (error?: Error, output = ''): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(output)
      }
      const stop = (): void => {
        if (channel) {
          try {
            channel.signal('TERM')
          } catch {
            /* The channel may already be closed. */
          }
          channel.destroy()
        }
      }
      const abort = (): void => {
        stop()
        finish(
          new AppError(
            'CANCELLED',
            'The operation was cancelled. Some remote changes may already have completed.',
            'Refresh the server state before retrying.',
          ),
        )
      }
      const timer = setTimeout(() => {
        stop()
        finish(
          new AppError(
            'OPERATION_TIMEOUT',
            'The remote command timed out.',
            'Refresh to inspect the actual server state before retrying.',
            true,
          ),
        )
      }, timeout)
      signal?.addEventListener('abort', abort, { once: true })
      s.client.exec(command, (error, stream) => {
        if (error) {
          finish(error)
          return
        }
        channel = stream
        if (finished) {
          stop()
          return
        }
        s.channels.add(stream)
        let out = ''
        let length = 0
        stream.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 2 * 1024 * 1024) {
            stream.destroy()
            finish(
              new AppError('UNSUPPORTED_OPERATION', 'Remote output exceeded the safety limit.'),
            )
          } else out += chunk.toString('utf8')
        })
        // stderr can contain private command arguments or secrets; do not forward it to logs/UI.
        stream.stderr.resume()
        stream.on('error', (error: Error) => finish(error))
        stream.on('close', (code: number | null) => {
          s.channels.delete(stream)
          if (code !== 0)
            finish(
              new AppError(
                'SERVICE_ERROR',
                `The server command did not succeed (exit ${code ?? 'unknown'}).`,
                'Check permissions and server state in Terminal. No elevation is attempted.',
                true,
              ),
            )
          else finish(undefined, out)
        })
      })
    })
  }
}
