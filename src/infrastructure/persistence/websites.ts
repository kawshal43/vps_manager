import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../domain/errors/app-error'
import {
  deploymentHistorySchema,
  websiteRecordSchema,
  type WebsiteRecord,
  type DeploymentHistory,
} from '../../domain/websites/types'

const schema = z
  .object({
    version: z.literal(1),
    websites: z.array(websiteRecordSchema).max(500),
    history: z.array(deploymentHistorySchema).max(1000),
  })
  .strict()
export class WebsiteRepository {
  private data: z.infer<typeof schema> = { version: 1, websites: [], history: [] }
  private writes = Promise.resolve()
  private invalid = false
  constructor(private directory: string) {}
  async load(): Promise<void> {
    try {
      if ((await stat(join(this.directory, 'websites.json'))).size > 64 * 1024 ** 2)
        throw new Error('Website metadata exceeds its size bound')
      this.data = schema.parse(
        JSON.parse(await readFile(join(this.directory, 'websites.json'), 'utf8')),
      )
      for (const entry of this.data.history)
        if (entry.status === 'running') {
          entry.status = 'interrupted'
          entry.message =
            'The app stopped during this operation. Inspect runtime state before recovery.'
        }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.invalid = true
        throw new AppError(
          'INVALID_REQUEST',
          'websites.json is invalid or newer. It was preserved; repair it before using Websites.',
        )
      }
    }
  }
  records(scope: string): WebsiteRecord[] {
    if (this.invalid)
      throw new AppError(
        'INVALID_REQUEST',
        'websites.json is invalid. The file was preserved; repair it before using Websites.',
      )
    return structuredClone(this.data.websites.filter((w) => w.scope === scope))
  }
  history(scope: string, websiteId?: string): DeploymentHistory[] {
    return structuredClone(
      this.data.history.filter(
        (h) => h.scope === scope && (!websiteId || h.websiteId === websiteId),
      ),
    )
  }
  saveRecord(value: WebsiteRecord): Promise<void> {
    const clean = websiteRecordSchema.parse(value)
    if (!this.data.websites.some((w) => w.id === clean.id) && this.data.websites.length >= 500)
      throw new AppError('INVALID_REQUEST', 'The website registration limit is 500.')
    this.data.websites = [...this.data.websites.filter((w) => w.id !== clean.id), clean]
    return this.flush()
  }
  saveHistory(value: DeploymentHistory): Promise<void> {
    const clean = deploymentHistorySchema.parse(value)
    this.data.history = [...this.data.history.filter((h) => h.id !== clean.id), clean].slice(-1000)
    let budget = 4 * 1024 ** 2
    for (const item of [...this.data.history].reverse()) {
      const kept: string[] = []
      for (const line of [...item.log].reverse()) {
        const size = Buffer.byteLength(line, 'utf8')
        if (size > budget) break
        budget -= size
        kept.unshift(line)
      }
      item.log = kept
    }
    return this.flush()
  }
  flush(): Promise<void> {
    if (this.invalid)
      return Promise.reject(
        new AppError('INVALID_REQUEST', 'The original websites.json is preserved.'),
      )
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const temporary = join(this.directory, `websites.${randomUUID()}.tmp`)
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, 'websites.json'))
      })
    return this.writes
  }
}
