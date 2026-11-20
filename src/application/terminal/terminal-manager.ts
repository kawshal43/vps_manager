import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import type { AppEvent } from '../../shared/contracts/api'
import type { SessionManager } from '../connection/session-manager'
import { AppError } from '../../domain/errors/app-error'
import { quotePosix, validatePath } from '../../domain/filesystem/policy'
interface TerminalChannel {
  stream: ClientChannel
  sessionId: string
  pending: number
}
export class TerminalManager {
  private terminals = new Map<string, TerminalChannel>()
  constructor(
    private sessions: SessionManager,
    private emit: (e: AppEvent) => void,
  ) {}
  async open(sessionId: string, cols: number, rows: number, cwd?: string): Promise<string> {
    if (this.terminals.size >= 16)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Close an existing terminal before opening another (limit 16).',
      )
    const session = this.sessions.get(sessionId)
    const id = randomUUID()
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      session.client.shell({ term: 'xterm-256color', cols, rows }, (e, s) =>
        e ? reject(e) : resolve(s),
      ),
    )
    const terminal: TerminalChannel = { stream, sessionId, pending: 0 }
    this.terminals.set(id, terminal)
    session.channels.add(stream)
    // Defer stream delivery until the renderer has received the terminal id.
    stream.pause()
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => {
      terminal.pending += chunk.length
      this.emit({ type: 'terminal-data', id, data: decoder.write(chunk), bytes: chunk.length })
      if (terminal.pending >= 256 * 1024) stream.pause()
    })
    stream.on('error', () => {})
    stream.on('close', () => {
      this.terminals.delete(id)
      session.channels.delete(stream)
      this.emit({ type: 'terminal-exit', id })
    })
    if (cwd) stream.write(`cd -- ${quotePosix(validatePath(cwd))}\n`)
    return id
  }
  private get(id: string): TerminalChannel {
    const t = this.terminals.get(id)
    if (!t) throw new AppError('NETWORK_ERROR', 'This terminal has closed.')
    this.sessions.get(t.sessionId)
    return t
  }
  input(id: string, data: string): void {
    const t = this.get(id)
    if (t.stream.writableLength > 1024 * 1024)
      throw new AppError('INVALID_REQUEST', 'Terminal input is arriving too quickly.')
    t.stream.write(data)
  }
  ack(id: string, bytes: number): void {
    // Output already delivered to xterm can be acknowledged after its tab closes.
    // A late acknowledgement must not turn a normal close into an error.
    const t = this.terminals.get(id)
    if (!t) return
    this.sessions.get(t.sessionId)
    t.pending = Math.max(0, t.pending - bytes)
    if (t.pending < 128 * 1024) t.stream.resume()
  }
  resize(id: string, cols: number, rows: number): void {
    this.get(id).stream.setWindow(rows, cols, 0, 0)
  }
  close(id: string): void {
    const t = this.terminals.get(id)
    if (t) {
      // Close only this SSH channel without injecting commands into whichever
      // foreground program the user is running.
      t.stream.close()
      this.terminals.delete(id)
    }
  }
}
