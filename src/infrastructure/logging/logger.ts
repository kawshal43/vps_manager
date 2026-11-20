import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppErrorData } from '../../domain/errors/app-error'
export class Logger {
  private writes = Promise.resolve()
  constructor(public directory: string) {}
  error(error: AppErrorData): void {
    // Deliberate allowlist: no request payloads, shell output, filenames, or Error stacks.
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        operation: error.operation,
        code: error.code,
      }) + '\n'
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const path = join(this.directory, 'diagnostics.log')
        const size = await stat(path).then(
          (s) => s.size,
          () => 0,
        )
        if (size > 2 * 1024 * 1024)
          await rename(path, join(this.directory, 'diagnostics.previous.log'))
        await appendFile(path, line, { mode: 0o600 })
      })
    void this.writes.catch(() => {})
  }
}
