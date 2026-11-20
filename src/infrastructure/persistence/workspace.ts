import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultWorkspace, workspaceSchema, type WorkspaceLayout } from '../../shared/workspace'
import { AppError } from '../../domain/errors/app-error'

/** Appearance is independent of profiles and credentials. Invalid files are preserved. */
export class WorkspaceRepository {
  private layout = defaultWorkspace()
  private warning?: string
  private writes: Promise<void> = Promise.resolve()
  constructor(private directory: string) {}
  async load() {
    try {
      this.layout = workspaceSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'workspace.json'), 'utf8')),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.warning =
          'Saved desktop layout could not be loaded. The original workspace.json was preserved; layout changes will not be saved until it is repaired.'
    }
    return { layout: structuredClone(this.layout), warning: this.warning }
  }
  save(value: WorkspaceLayout): Promise<void> {
    if (this.warning) throw new AppError('INVALID_REQUEST', this.warning)
    this.layout = workspaceSchema.parse(value)
    const snapshot = JSON.stringify(this.layout, null, 2)
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const temporary = join(this.directory, `workspace.${randomUUID()}.tmp`)
        await writeFile(temporary, snapshot, { mode: 0o600 })
        await rename(temporary, join(this.directory, 'workspace.json'))
      })
    return this.writes
  }
  flush() {
    return this.writes
  }
}
