import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  defaultPreferences,
  type Preferences,
  type ServerProfile,
  type TrustedHost,
} from '../../domain/connection/types'
import { deploymentSchema, preferencesSchema, profileSchema } from '../../shared/schemas'
import type { Deployment } from '../../domain/applications/types'
import { AppError } from '../../domain/errors/app-error'

const schema = z.object({
  version: z.literal(2),
  deployments: z.array(deploymentSchema),
  preferences: preferencesSchema,
  profiles: z.array(profileSchema),
  trustedHosts: z.array(
    z.object({
      host: z.string(),
      port: z.number(),
      fingerprint: z.string(),
      keyType: z.string(),
      acceptedAt: z.string(),
    }),
  ),
  credentials: z.record(z.string(), z.string()),
})
type Data = z.infer<typeof schema>
export class SettingsRepository {
  private data: Data = {
    version: 2,
    deployments: [],
    preferences: { ...defaultPreferences },
    profiles: [],
    trustedHosts: [],
    credentials: {},
  }
  private writes: Promise<void> = Promise.resolve()
  constructor(private directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'))
      // Preserve all v1 profiles, trust and ciphertext while adding app metadata.
      const value = raw as { version?: number; preferences?: object; profiles?: unknown[] }
      this.data = schema.parse(
        value.version === 0
          ? {
              version: 2,
              deployments: [],
              preferences: { ...defaultPreferences, ...value.preferences },
              profiles: value.profiles ?? [],
              trustedHosts: [],
              credentials: {},
            }
          : value.version === 1
            ? { ...value, version: 2, deployments: [] }
            : raw,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(
          'INVALID_REQUEST',
          'Local settings are invalid or use a newer version.',
          'Back up settings.json in the application data folder before repairing it. The file has been preserved.',
        )
    }
  }
  profiles(): ServerProfile[] {
    return this.data.profiles.map((p) => ({ ...p, hasCredential: !!this.data.credentials[p.id] }))
  }
  preferences(): Preferences {
    return { ...this.data.preferences }
  }
  hosts(): TrustedHost[] {
    return this.data.trustedHosts.map((h) => ({ ...h }))
  }
  credential(id: string): string | undefined {
    return this.data.credentials[id]
  }
  deployments(): Deployment[] {
    return this.data.deployments.map((value) => ({ ...value }))
  }
  async saveDeployment(value: Deployment): Promise<void> {
    const record = deploymentSchema.parse(value)
    this.data.deployments = [
      ...this.data.deployments.filter((item) => item.id !== record.id),
      record,
    ]
    await this.flush()
  }
  async removeDeployment(id: string): Promise<void> {
    this.data.deployments = this.data.deployments.filter((item) => item.id !== id)
    await this.flush()
  }
  async updatePreferences(p: Preferences): Promise<void> {
    this.data.preferences = preferencesSchema.parse(p)
    await this.flush()
  }
  async saveProfile(p: ServerProfile): Promise<void> {
    const clean = profileSchema.parse({
      id: p.id,
      displayName: p.displayName,
      host: p.host,
      port: p.port,
      username: p.username,
      authenticationMethod: p.authenticationMethod,
      privateKeyReference: p.privateKeyReference,
      lastConnectedAt: p.lastConnectedAt,
      lastDirectory: p.lastDirectory,
    })
    this.data.profiles = [...this.data.profiles.filter((v) => v.id !== p.id), clean]
    await this.flush()
  }
  async removeProfile(id: string): Promise<void> {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id)
    delete this.data.credentials[id]
    await this.flush()
  }
  async saveCredential(id: string, secret?: string): Promise<void> {
    if (secret) this.data.credentials[id] = secret
    else delete this.data.credentials[id]
    await this.flush()
  }
  async trust(host: TrustedHost): Promise<void> {
    this.data.trustedHosts.push(host)
    await this.flush()
  }
  flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const temporary = join(this.directory, `settings.${randomUUID()}.tmp`)
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, 'settings.json'))
      })
    this.writes = next
    return next
  }
}
