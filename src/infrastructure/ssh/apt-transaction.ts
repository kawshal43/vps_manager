import type { ClientChannel } from 'ssh2'
import type { SessionManager } from '../../application/connection/session-manager'
import { AppError } from '../../domain/errors/app-error'
import { equalPackageNames, parseActualRemoval } from '../../domain/applications/policy'

/** Answer only APT's final prompt after checking the real locked transaction. */
export async function runAptRemoval(
  sessions: SessionManager,
  sessionId: string,
  command: string,
  expected: string[],
  confirm: () => Promise<boolean>,
  onRunning: () => void,
): Promise<'completed' | 'cancelled'> {
  const live = sessions.get(sessionId)
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    let output = ''
    let bytes = 0
    let prompting = false
    let approved = false
    let cancelled = false
    let finished = false
    const finish = (error?: Error, value: 'completed' | 'cancelled' = 'completed'): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      live.lifetime.signal.removeEventListener('abort', lost)
      if (error) reject(error)
      else resolve(value)
    }
    const uncertain = () =>
      new AppError(
        'TRANSFER_INTERRUPTED',
        approved
          ? 'The uninstall result is uncertain because the connection ended. Refresh the inventory and inspect package state before retrying.'
          : 'The uninstall stopped before confirmation. No approval was sent.',
        'Inspect the server state. Uninstalls are never replayed automatically.',
      )
    const lost = (): void => finish(uncertain())
    const timer = setTimeout(() => {
      channel?.end('n\n')
      channel?.close()
      finish(
        new AppError(
          'OPERATION_TIMEOUT',
          approved
            ? 'Package removal exceeded the time limit; its final state is uncertain.'
            : 'Package removal confirmation timed out.',
          'Refresh package state before taking another action.',
        ),
      )
    }, 300000)
    live.lifetime.signal.addEventListener('abort', lost, { once: true })
    live.client.exec(command, (error, stream) => {
      if (error) {
        finish(error)
        return
      }
      channel = stream
      live.channels.add(stream)
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) {
          stream.end('n\n')
          stream.close()
          finish(
            new AppError(
              'UNSUPPORTED_OPERATION',
              'APT output exceeded the safety limit.',
              approved ? 'Inspect package state before retrying.' : 'No approval was sent.',
            ),
          )
          return
        }
        if (!approved) output += chunk.toString('utf8')
        if (!prompting && /Do you want to continue\?\s*\[[Yy]\/n\]/.test(output)) {
          prompting = true
          void (async () => {
            if (!equalPackageNames(parseActualRemoval(output), expected))
              throw new AppError(
                'FILE_CONFLICT',
                'The real APT proposal differs from the preview. Removal was blocked.',
              )
            const accept = await confirm()
            if (finished || live.lifetime.signal.aborted) return
            if (!accept) {
              cancelled = true
              stream.end('n\n')
              return
            }
            approved = true
            output = ''
            onRunning()
            stream.write('y\n')
          })().catch((failure: Error) => {
            stream.end('n\n')
            stream.close()
            finish(failure)
          })
        }
      })
      stream.stderr.resume()
      stream.on('error', () => finish(uncertain()))
      stream.on('close', (code: number | null) => {
        live.channels.delete(stream)
        if (cancelled) finish(undefined, 'cancelled')
        else if (code !== 0)
          finish(
            new AppError(
              'PERMISSION_DENIED',
              'APT removal did not complete successfully.',
              'Check Linux permissions, sudo authorization and package state in Terminal. No password or automatic elevation is attempted.',
            ),
          )
        else if (!approved)
          finish(
            new AppError(
              'FILE_CONFLICT',
              'APT ended without the expected confirmation. Refresh the inventory.',
            ),
          )
        else finish()
      })
    })
  })
}
