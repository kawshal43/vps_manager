import { runServerSmoke } from './server-smoke'
import { runTerminalProbe } from './server-terminal-probe'
import { inspectServerApplications } from './server-app-readonly'
import { inspectApplicationUi } from './server-app-ui'
import { join } from 'node:path'

async function main(): Promise<void> {
  const host = process.argv[2]
  if (!host || !process.env.APPDATA)
    throw new Error(
      'Supply the explicit host and use the Windows account containing its saved profile.',
    )
  // Receive the secret through stdin, never through command-line arguments or a file.
  const terminal = process.stdin.isTTY
  if (terminal) process.stdin.setRawMode(true)
  process.stdout.write('Password input ready (hidden).\n')
  const authentication = {
    secret: await new Promise<string>((resolve, reject) => {
      let value = ''
      const cleanup = (): void => {
        clearTimeout(timer)
        process.stdin.off('data', receive)
        process.stdin.pause()
        if (terminal) process.stdin.setRawMode(false)
      }
      const receive = (chunk: Buffer): void => {
        value += chunk.toString('utf8')
        if (value.includes('\u0003')) {
          cleanup()
          value = ''
          reject(new Error('Cancelled'))
          return
        }
        const end = value.search(/[\r\n]/)
        if (end >= 0) {
          const password = value.slice(0, end)
          value = ''
          cleanup()
          resolve(password)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        value = ''
        reject(new Error('Secret input timed out'))
      }, 60000)
      process.stdin.on('data', receive)
      process.stdin.resume()
    }),
  }
  try {
    const input = {
      host,
      secret: authentication.secret,
      cleanupPrevious: process.argv[3]?.startsWith('--') ? undefined : process.argv[3],
      extended: process.argv[3] === '--extended',
      immediate: process.argv[3] === '--terminal-probe-immediate',
      settingsDirectory: join(process.env.APPDATA, 'vps-manager'),
      progress: (message: string): void => {
        process.stdout.write(`PASS ${message}\n`)
      },
    }
    authentication.secret = ''
    const report =
      process.argv[3] === '--apps-ui-readonly'
        ? await inspectApplicationUi(input)
        : process.argv[3] === '--apps-readonly'
          ? await inspectServerApplications(input)
          : process.argv[3]?.startsWith('--terminal-probe')
            ? await runTerminalProbe(input)
            : await runServerSmoke(input)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if ('remoteCleanup' in report && (('error' in report && report.error) || !report.remoteCleanup))
      process.exitCode = 1
    if ('errors' in report && Array.isArray(report.errors) && report.errors.length)
      process.exitCode = 1
  } finally {
    authentication.secret = ''
  }
}
void main().catch(() => {
  process.stderr.write('Server smoke test could not start; no secret was saved.\n')
  process.exitCode = 1
})
