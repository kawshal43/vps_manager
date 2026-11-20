import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { AppError, mapError } from '../../domain/errors/app-error'
import { quotePosix as q } from '../../domain/filesystem/policy'
import {
  childPath,
  compareFiles,
  deploymentPath,
  hash,
  manifestHash,
  redactLog,
  safeGitUrl,
  DeploymentLogSanitizer,
} from '../../domain/websites/policy'
import {
  websiteInputSchema,
  type WebsiteInput,
  type WebsiteRecord,
  type DeploymentHistory,
  type DeploymentPreview,
  type DeploymentProgress,
  type HealthResult,
  type Elevation,
  type UpdateMethod,
  type UpdateSource,
} from '../../domain/websites/types'
import { WebsiteRepository } from '../../infrastructure/persistence/websites'
import {
  ProjectIO,
  cleanSource,
  unzipSource,
  type Manifest,
  type ProjectSource,
} from '../../infrastructure/websites/project-io'
import {
  buildOverride,
  composeFingerprint,
  composeProtectedPaths,
  composeSecrets,
  inspectCompose,
  parseComposeModel,
  runtimeMountBlockers,
  type ComposeModel,
} from '../../infrastructure/websites/compose'
import {
  composeAction,
  docker,
  gitCloneCommand,
  healthCommand,
} from '../../infrastructure/commands/websites'
import { sftpCall } from '../../infrastructure/sftp/remote-fs'
import type { SessionManager } from '../connection/session-manager'
import type { Confirm } from '../filesystem/file-operations'
import type { AppEvent } from '../../shared/contracts/api'
import { WebsiteDiscovery, type ContainerInfo } from './discovery'
import { websiteAdapter } from './adapters'

interface Plan {
  sessionId: string
  record: WebsiteRecord
  source: ProjectSource
  baseline: ProjectSource
  current: Manifest
  incoming: Manifest
  preview: DeploymentPreview
  elevation: Elevation
  model?: ComposeModel
  configHash: string
  containers: ContainerInfo[]
  restore?: DeploymentHistory
  protectedPaths: string[]
}
interface Running {
  progress: DeploymentProgress
  controller: AbortController
  lock: string
  interrupted?: boolean
  lastEmitted?: number
  lastStage?: string
}
export class WebsiteManager {
  private io: ProjectIO
  private discovery: WebsiteDiscovery
  private plans = new Map<string, Plan>()
  private running = new Map<string, Running>()
  private locks = new Set<string>()
  constructor(
    private sessions: SessionManager,
    private repository: WebsiteRepository,
    private confirm: Confirm,
    private emit: (event: AppEvent) => void,
  ) {
    this.io = new ProjectIO(sessions)
    this.discovery = new WebsiteDiscovery(sessions, (id) => this.io.fs(id))
  }
  scope(id: string): string {
    const p = this.sessions.get(id).info.profile
    return JSON.stringify([p.host.toLowerCase(), p.port, p.username])
  }
  private record(id: string, websiteId: string): WebsiteRecord {
    const record = this.repository.records(this.scope(id)).find((r) => r.id === websiteId)
    if (!record)
      throw new AppError(
        'FILE_NOT_FOUND',
        'This website is not registered in this server/account workspace.',
      )
    deploymentPath(record.config.projectPath, this.sessions.get(id).info.home)
    return record
  }
  private lockKey(id: string, record: WebsiteRecord): string {
    const p = this.sessions.get(id).info.profile
    return JSON.stringify([
      p.host.toLowerCase(),
      p.port,
      record.config.compose?.project ?? record.config.projectPath,
    ])
  }
  private free(id: string, record: WebsiteRecord): void {
    if (this.locks.has(this.lockKey(id, record)))
      throw new AppError(
        'FILE_CONFLICT',
        'An operation is already running for this website or Compose project.',
      )
  }
  async discover(id: string, elevation: Elevation) {
    const result = await this.discovery.discover(
      id,
      this.repository.records(this.scope(id)),
      elevation,
    )
    for (const site of result.websites)
      site.lastDeployment = this.repository.history(this.scope(id), site.id).at(-1)?.endedAt
    return result
  }
  async register(id: string, input: WebsiteInput, websiteId?: string): Promise<WebsiteRecord> {
    const config = websiteInputSchema.parse(input),
      scope = this.scope(id)
    const existing = websiteId ? this.record(id, websiteId) : undefined
    if (existing) {
      this.free(id, existing)
      if (this.plans.size && [...this.plans.values()].some((p) => p.record.id === existing.id))
        throw new AppError(
          'FILE_CONFLICT',
          'Close or discard the open deployment preview before changing this mapping.',
        )
      if (
        this.repository.history(scope, existing.id).length &&
        JSON.stringify(existing.config) !== JSON.stringify(config)
      )
        throw new AppError(
          'FILE_CONFLICT',
          'A website with deployment history cannot be remapped. Import a separate website to preserve recovery metadata.',
        )
    }
    const path = deploymentPath(config.projectPath, this.sessions.get(id).info.home),
      fs = this.io.fs(id)
    if (!existing?.activeRelease) {
      const stat = await fs.lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(path)) !== path)
        throw new AppError(
          'INVALID_PATH',
          'Register a canonical application directory, not a link.',
        )
    }
    for (const other of this.repository.records(scope).filter((r) => r.id !== websiteId)) {
      if (
        other.config.domain === config.domain ||
        path === other.config.projectPath ||
        path.startsWith(other.config.projectPath + '/') ||
        other.config.projectPath.startsWith(path + '/')
      )
        throw new AppError(
          'FILE_CONFLICT',
          'A registered website already uses this domain or overlapping project directory.',
        )
    }
    const now = new Date().toISOString()
    const record: WebsiteRecord = {
      ...existing,
      id: existing?.id ?? randomUUID(),
      scope,
      config: { ...config, projectPath: path },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) this.free(id, existing)
    await this.repository.saveRecord(record)
    return record
  }
  history(id: string, websiteId: string): DeploymentHistory[] {
    this.record(id, websiteId)
    return this.repository.history(this.scope(id), websiteId)
  }
  operations(id: string): DeploymentProgress[] {
    this.sessions.get(id)
    return [...this.running.values()]
      .filter((r) => r.progress.sessionId === id)
      .map((r) => structuredClone(r.progress))
  }
  runningCount(): number {
    return [...this.running.values()].filter((r) => r.progress.state === 'running').length
  }
  disconnect(sessionId: string): void {
    for (const r of this.running.values())
      if (r.progress.sessionId === sessionId && r.progress.state === 'running') {
        r.interrupted = true
        r.controller.abort()
        this.report(
          r,
          'Connection lost',
          'Deployment will not be replayed. Reconnect and inspect the selected application before recovery.',
        )
      }
  }
  dispose(): void {
    for (const r of this.running.values()) if (r.progress.cancellable) r.controller.abort()
    for (const p of this.plans.values()) void cleanSource(p.source.temporary).catch(() => {})
  }
  private storage(record: WebsiteRecord): string {
    return posix.join(posix.dirname(record.config.projectPath), `.vps-websites-${record.id}`)
  }
  private async ensureStorage(id: string, record: WebsiteRecord): Promise<string> {
    const fs = this.io.fs(id),
      root = this.storage(record)
    if (!(await fs.exists(root))) {
      await fs.mkdir(root)
      await sftpCall<void>((cb) =>
        fs.sftp.chmod(root, record.config.strategy === 'static' ? 0o755 : 0o700, (e) =>
          cb(e, undefined),
        ),
      )
      await this.io.writeJson(id, childPath(root, 'owner.json'), { websiteId: record.id })
    }
    if (
      (await fs.realpath(root)) !== root ||
      (await fs.lstat(root)).isSymbolicLink() ||
      JSON.parse((await fs.text(childPath(root, 'owner.json'))).content).websiteId !== record.id
    )
      throw new AppError(
        'INVALID_PATH',
        'Website release storage is not owned by this registration.',
      )
    for (const part of ['releases', 'backups']) await fs.ensureDirectory(childPath(root, part))
    await sftpCall<void>((cb) =>
      fs.sftp.chmod(childPath(root, 'backups'), 0o700, (e) => cb(e, undefined)),
    )
    return root
  }
  private async baseline(id: string, record: WebsiteRecord): Promise<ProjectSource> {
    const fs = this.io.fs(id),
      path = record.config.projectPath
    if (
      record.config.strategy === 'static' &&
      record.activeRelease &&
      (await fs.realpath(path)) !== record.activeRelease
    )
      throw new AppError(
        'FILE_CONFLICT',
        'The published document root changed outside VPS Manager. Inspect it before updating.',
      )
    return { kind: 'remote', root: record.activeRelease ?? path }
  }
  private async inspect(id: string, record: WebsiteRecord, elevation: Elevation) {
    if (record.config.strategy !== 'compose')
      return {
        model: undefined,
        containers: [],
        configHash: hash(JSON.stringify(record.config)),
        blocked: [],
        protected: [],
        protectedPaths: record.config.protectedPaths,
      }
    const model = parseComposeModel(
      await this.sessions.exec(id, composeAction(record.config, elevation, 'config'), 30000),
    )
    const containers = (await this.discovery.containers(id, elevation)).filter(
      (c) =>
        c.project === record.config.compose!.project && c.directory === record.config.projectPath,
    )
    const result = inspectCompose(record.config, model)
    result.blocked.push(...runtimeMountBlockers(record.config, model, containers))
    for (const service of record.config.compose!.services) {
      const selected = containers.filter((c) => c.service === service)
      if (selected.length !== 1)
        result.blocked.push(
          `${service} must have exactly one identifiable existing container. Initial deployments and scaled replicas require manual management.`,
        )
    }
    return {
      model,
      containers,
      configHash: hash(JSON.stringify(record.config) + composeFingerprint(model)),
      protectedPaths: composeProtectedPaths(record.config, model),
      ...result,
    }
  }
  async prepare(
    id: string,
    websiteId: string,
    method: UpdateMethod,
    sourceInput: UpdateSource,
    elevation: Elevation,
    paths: string[],
    local?: { path: string; zip: boolean },
  ): Promise<DeploymentPreview> {
    const record = this.record(id, websiteId)
    this.free(id, record)
    if (record.config.strategy === 'manual')
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'This runtime supports inspection only. Use a Compose or static mapping for managed updates.',
      )
    for (const [token, plan] of this.plans)
      if (plan.preview.expiresAt < Date.now()) {
        this.plans.delete(token)
        await cleanSource(plan.source.temporary)
      }
    if (this.plans.size >= 50)
      throw new AppError('INVALID_REQUEST', 'Too many deployment previews are open.')
    const inspected = await this.inspect(id, record, elevation)
    const baseline = await this.baseline(id, record),
      current = await this.io.manifest(id, baseline, inspected.protectedPaths)
    let source: ProjectSource = baseline
    try {
      if (method !== 'rebuild') {
        if (sourceInput.kind === 'local' && local)
          source = local.zip ? await unzipSource(local.path) : { kind: 'local', root: local.path }
        else if (sourceInput.kind === 'remote')
          source = {
            kind: 'remote',
            root: deploymentPath(sourceInput.path, this.sessions.get(id).info.home),
          }
        else if (sourceInput.kind === 'git') {
          safeGitUrl(sourceInput.url)
          const available = Number(
            (
              await this.sessions.exec(
                id,
                `df -B1 --output=avail -- ${q(posix.dirname(record.config.projectPath))} | tail -n 1`,
              )
            ).trim(),
          )
          if (
            !Number.isSafeInteger(available) ||
            available < 4 * 1024 ** 3 + current.bytes * 2 + 50 * 1024 ** 2
          )
            throw new AppError(
              'DISK_FULL',
              'Git source preparation requires 4 GiB of free checkout/cache space plus application backup space. Use a smaller prepared folder/ZIP or free storage first.',
            )
          const root = await this.ensureStorage(id, record),
            destination = childPath(root, `releases/${randomUUID()}.git-source`)
          const actual = await this.sessions.exec(
            id,
            gitCloneCommand(sourceInput.url, sourceInput.revision, destination),
            10 * 60000,
          )
          if (
            actual.trim().split(/\r?\n/).at(-1)?.toLowerCase() !==
            sourceInput.revision.toLowerCase()
          )
            throw new AppError(
              'FILE_CONFLICT',
              'The fetched Git revision did not match the selected commit.',
            )
          source = { kind: 'remote', root: destination }
        } else throw new AppError('INVALID_REQUEST', 'Select an update source.')
      }
      const incoming = await this.io.manifest(id, source, inspected.protectedPaths)
      if (method === 'partial') {
        if (!paths.length)
          throw new AppError(
            'INVALID_REQUEST',
            'Choose specific relative files or directories for a partial update.',
          )
        incoming.files = incoming.files.filter((f) =>
          paths.some((p) => f.path === p || f.path.startsWith(p + '/')),
        )
        incoming.bytes = incoming.files.reduce((sum, f) => sum + f.size, 0)
      }
      if (!incoming.files.length)
        throw new AppError('INVALID_REQUEST', 'No deployable source files were selected.')
      const changes = compareFiles(current.files, incoming.files, method)
      const blocked = [...inspected.blocked]
      const discovered = await this.discovery.discover(
        id,
        this.repository.records(this.scope(id)),
        elevation,
      )
      if (record.config.strategy === 'static') {
        try {
          for (const container of await this.discovery.containers(id, elevation)) {
            if (
              container.mounts.some(
                (m) =>
                  m.Type === 'bind' &&
                  m.Source &&
                  (m.Source === record.config.projectPath ||
                    m.Source.startsWith(record.config.projectPath + '/') ||
                    record.config.projectPath.startsWith(m.Source + '/')),
              )
            )
              blocked.push(
                'The static document root overlaps a container bind mount. Versioned symlink publication is unsupported for this hosting layout.',
              )
          }
        } catch {
          /* Discovery notes already explain unavailable Docker inspection. */
        }
      }
      for (const other of discovered.websites.filter((s) => s.id !== record.id)) {
        if (
          [other.documentRoot, other.projectPath].some(
            (p) =>
              p &&
              (p === record.config.projectPath ||
                p.startsWith(record.config.projectPath + '/') ||
                record.config.projectPath.startsWith(p + '/')),
          )
        )
          blocked.push(
            `This directory overlaps another hosted website: ${other.domain || other.name}. Shared deployment roots require manual separation.`,
          )
      }
      for (const file of record.config.compose?.files ?? []) {
        const next = incoming.files.find((f) => f.path === file)
        if (next) {
          const original = (
            await this.io.manifest(
              id,
              { kind: 'remote', root: posix.dirname(childPath(record.config.projectPath, file)) },
              inspected.protectedPaths,
            )
          ).files.find((f) => f.path === posix.basename(file))
          if (original?.hash !== next.hash)
            blocked.push(
              `Infrastructure file changed: ${file}. Review and apply infrastructure changes manually before a source-only deployment.`,
            )
        }
      }
      if (
        [...changes.added, ...changes.changed, ...incoming.skipped].some((p) =>
          /(?:^|\/)(?:migrations?|db\/(?:migration|changelog)|flyway|liquibase|alembic\/versions|prisma\/(?:schema\.prisma|migrations))(?:\/|\.|$)|schema\.sql/i.test(
            p,
          ),
        )
      )
        blocked.push(
          'Database migration files require a tested database backup/restoration workflow. Automatic migration deployment is blocked.',
        )
      blocked.push(...websiteAdapter(record.config).sourceBlockers(current, incoming, method))
      const freeBytes = Number(
        (
          await this.sessions.exec(
            id,
            `df -B1 --output=avail -- ${q(posix.dirname(record.config.projectPath))} | tail -n 1`,
          )
        ).trim(),
      )
      if (
        !Number.isSafeInteger(freeBytes) ||
        freeBytes < current.bytes * 2 + incoming.bytes + 50 * 1024 ** 2
      )
        blocked.push('Insufficient or unknown free storage for backup and release staging.')
      await this.sessions.exec(
        id,
        `test -r ${q(record.config.projectPath)} && test -w ${q(posix.dirname(record.config.projectPath))}`,
      )
      const preview: DeploymentPreview = {
        token: randomUUID(),
        websiteId,
        expiresAt: Date.now() + 10 * 60000,
        method,
        changes,
        bytes: incoming.bytes,
        fileCount: incoming.files.length,
        services: record.config.compose?.services ?? [],
        protected: [
          ...new Set([
            ...current.skipped,
            ...incoming.skipped,
            ...inspected.protected,
            ...(record.config.compose?.files ?? []),
          ]),
        ],
        blocked,
        freeBytes,
        warnings: [
          'Only application source/images are backed up. Databases, media, secrets and certificates are not backed up or restored.',
          'Build scripts and application startup code run with existing server/Docker permissions. Review source and confirm it performs no database migration.',
          'Activation may interrupt the selected application. Public reachability from other networks is not guaranteed by a server-side check.',
          ...(record.config.strategy === 'static' && !record.activeRelease
            ? [
                'First static activation moves the original directory into the backup area before installing the release link; a brief routing interruption is possible.',
              ]
            : []),
        ],
      }
      this.plans.set(preview.token, {
        sessionId: id,
        record,
        source,
        baseline,
        current,
        incoming,
        preview,
        elevation,
        ...inspected,
      })
      return preview
    } catch (error) {
      await cleanSource(source.temporary)
      throw error
    }
  }
  async discard(id: string, token: string): Promise<void> {
    const plan = this.plans.get(token)
    if (!plan || plan.sessionId !== id)
      throw new AppError('INVALID_REQUEST', 'This preview does not belong to this connection.')
    this.plans.delete(token)
    await cleanSource(plan.source.temporary)
  }
  private report(run: Running, stage: string, message?: string): void {
    run.progress.stage = stage
    if (message) run.progress.log = [...run.progress.log, redactLog(message)].slice(-200)
    if (
      stage === run.lastStage &&
      Date.now() - (run.lastEmitted ?? 0) < 250 &&
      run.progress.state === 'running'
    )
      return
    run.lastStage = stage
    run.lastEmitted = Date.now()
    this.emit({ type: 'website-deployment', operation: structuredClone(run.progress) })
  }
  async deploy(id: string, token: string, acknowledged: boolean): Promise<string | null> {
    const plan = this.plans.get(token)
    if (!plan || plan.sessionId !== id || plan.preview.expiresAt < Date.now())
      throw new AppError(
        'INVALID_REQUEST',
        'This deployment preview expired or belongs to another connection.',
      )
    this.free(id, plan.record)
    if (!acknowledged || plan.preview.blocked.length)
      throw new AppError(
        'PERMISSION_DENIED',
        'Resolve the preview blockers and acknowledge application/database limitations before deployment.',
      )
    const lock = this.lockKey(id, plan.record)
    this.locks.add(lock)
    try {
      if (
        !(await this.confirm(
          'Deploy website',
          `Update ${plan.record.config.domain}?`,
          `${plan.record.config.projectPath}\nMethod: ${plan.preview.method}\nServices: ${plan.preview.services.join(', ') || 'static assets'}\nAuthorization: ${plan.elevation}\n\n${plan.preview.warnings.join('\n')}`,
        ))
      )
        return null
      this.plans.delete(token)
      return await this.start(plan, lock)
    } finally {
      if (
        ![...this.running.values()].some((r) => r.lock === lock && r.progress.state === 'running')
      )
        this.locks.delete(lock)
    }
  }
  private async start(plan: Plan, lock: string): Promise<string> {
    const id = randomUUID(),
      startedAt = new Date().toISOString()
    const run: Running = {
      lock,
      controller: new AbortController(),
      progress: {
        id,
        websiteId: plan.record.id,
        sessionId: plan.sessionId,
        state: 'running',
        stage: 'Revalidating preview',
        startedAt,
        transferred: 0,
        total:
          plan.current.bytes +
          plan.incoming.bytes +
          (plan.preview.method === 'partial' ? plan.current.bytes : 0),
        log: [],
        cancellable: true,
      },
    }
    const history: DeploymentHistory = {
      id,
      scope: plan.record.scope,
      websiteId: plan.record.id,
      startedAt,
      action: plan.restore ? 'restore' : 'deploy',
      status: 'running',
      message: 'Preparing deployment',
      backupVerified: false,
      backupBytes: 0,
      backupHash: '',
      previousImages: {},
      configHash: plan.configHash,
      previousRelease: plan.record.activeRelease,
      previousOverride: plan.record.activeOverride,
      log: [],
    }
    await this.repository.saveHistory(history)
    this.running.set(id, run)
    this.report(run, 'Revalidating preview')
    void this.execute(plan, run, history)
      .catch(() => {})
      .finally(() => {
        this.locks.delete(lock)
        void cleanSource(plan.source.temporary).catch(() => {})
      })
    return id
  }
  cancel(id: string, operationId: string): void {
    this.sessions.get(id)
    const run = this.running.get(operationId)
    if (!run || run.progress.sessionId !== id || run.progress.state !== 'running')
      throw new AppError('INVALID_REQUEST', 'This operation is not running in this connection.')
    if (!run.progress.cancellable)
      throw new AppError(
        'INVALID_REQUEST',
        'Activation has begun. Wait for verification, then use the backup to recover if needed.',
      )
    run.controller.abort()
    this.report(
      run,
      'Cancelling before activation',
      'Stopping source transfer/build. The current application has not been activated.',
    )
  }
  private async execute(plan: Plan, run: Running, history: DeploymentHistory): Promise<void> {
    const id = plan.sessionId,
      signal = run.controller.signal,
      fs = this.io.fs(id),
      record = plan.record
    const progress = (bytes: number) => {
      run.progress.transferred += bytes
      if (Date.now() - lastProgress > 250) {
        lastProgress = Date.now()
        this.report(run, run.progress.stage)
      }
    }
    let lastProgress = 0
    let activated = false
    try {
      if (JSON.stringify(this.record(id, record.id)) !== JSON.stringify(record))
        throw new AppError('FILE_CONFLICT', 'Website configuration changed after preview.')
      if (
        manifestHash(
          (await this.io.manifest(id, plan.baseline, plan.protectedPaths, signal)).files,
        ) !== manifestHash(plan.current.files)
      )
        throw new AppError(
          'FILE_CONFLICT',
          'Current source changed after preview. Create a new preview.',
        )
      const incoming = await this.io.manifest(id, plan.source, plan.protectedPaths, signal)
      const next = incoming.files.filter((f) =>
        plan.incoming.files.some((old) => old.path === f.path),
      )
      if (manifestHash(next) !== manifestHash(plan.incoming.files))
        throw new AppError('FILE_CONFLICT', 'Update source changed after preview.')
      const inspected = await this.inspect(id, record, plan.elevation)
      if (inspected.configHash !== plan.configHash || inspected.blocked.length)
        throw new AppError(
          'FILE_CONFLICT',
          'Runtime configuration changed after preview or is unsafe.',
        )
      const root = await this.ensureStorage(id, record)
      const backupRoot = childPath(root, `backups/${history.id}`),
        backup = childPath(backupRoot, 'source'),
        release = childPath(root, `releases/${history.id}`)
      await fs.mkdir(backupRoot)
      await fs.mkdir(backup)
      await fs.mkdir(release)
      history.backupPath = backup
      history.releasePath = release
      this.report(
        run,
        'Creating application backup',
        'Copying the previous deployable source; persistent data and environment files stay in place.',
      )
      await this.io.copy(id, plan.baseline, plan.current.files, backup, signal, progress)
      if (record.config.strategy === 'compose') {
        for (const service of record.config.compose!.services) {
          const image = inspected.containers.find((c) => c.service === service)!.image
          history.previousImages[service] = image
          await this.sessions.exec(
            id,
            `${docker(plan.elevation)} image tag ${q(image)} ${q(`vps-manager/backup-${history.id}/service-${hash(service).slice(0, 12)}:retained`)}`,
            30000,
            signal,
          )
        }
      }
      const backedUp = await this.io.manifest(
        id,
        { kind: 'remote', root: backup },
        plan.protectedPaths,
        signal,
      )
      history.backupVerified = true
      history.backupBytes = backedUp.bytes
      history.backupHash = manifestHash(backedUp.files)
      await this.io.writeJson(id, childPath(backupRoot, 'snapshot.json'), {
        id: history.id,
        websiteId: record.id,
        files: backedUp.files,
        images: history.previousImages,
        includes: ['application source', 'previous image references'],
        excludes: ['databases', 'persistent media', 'secrets', 'certificates'],
      })
      await this.repository.saveHistory(history)
      this.report(run, 'Staging release', 'Uploading source and verifying every file with SHA-256.')
      if (plan.preview.method === 'partial')
        await this.io.copy(id, plan.baseline, plan.current.files, release, signal, progress)
      await this.io.copy(id, plan.source, plan.incoming.files, release, signal, progress)
      let override: string | undefined
      const expectedImages: Record<string, string> = {}
      if (record.config.strategy === 'compose') {
        override = childPath(root, `releases/${history.id}.compose.json`)
        const value = plan.restore
          ? {
              services: Object.fromEntries(
                Object.entries(plan.restore.previousImages).map(([name, image]) => [
                  name,
                  { image },
                ]),
              ),
            }
          : buildOverride(record.config, inspected.model!, release, history.id)
        await this.io.writeJson(id, override, value)
        // Validate the merged model before any build or service action.
        const merged = parseComposeModel(
          await this.sessions.exec(
            id,
            composeAction(record.config, plan.elevation, 'config', override),
            30000,
            signal,
          ),
        )
        if (
          hash(
            JSON.stringify({
              ...merged,
              services: Object.fromEntries(
                Object.entries(merged.services).map(([name, s]) => [
                  name,
                  { ...s, image: undefined, build: undefined },
                ]),
              ),
            }),
          ) !==
          hash(
            JSON.stringify({
              ...inspected.model,
              services: Object.fromEntries(
                Object.entries(inspected.model!.services).map(([name, s]) => [
                  name,
                  { ...s, image: undefined, build: undefined },
                ]),
              ),
            }),
          )
        )
          throw new AppError(
            'FILE_CONFLICT',
            'The release override changed runtime infrastructure. Activation was blocked.',
          )
        if (!plan.restore) {
          this.report(
            run,
            'Building selected services',
            `Building ${record.config.compose!.services.join(', ')}. No dependencies or database services are started.`,
          )
          const secrets = composeSecrets(inspected.model!)
          const output = new DeploymentLogSanitizer(
            (text) => this.report(run, 'Building selected services', text),
            secrets,
          )
          await this.sessions.exec(
            id,
            composeAction(record.config, plan.elevation, 'build', override),
            30 * 60000,
            signal,
            (chunk) => output.feed(chunk),
          )
          output.flush()
        }
        for (const service of record.config.compose!.services) {
          const image = plan.restore?.previousImages[service] ?? merged.services[service].image
          if (!image)
            throw new AppError(
              'SERVICE_ERROR',
              'The release image reference could not be verified.',
            )
          const imageId = (
            await this.sessions.exec(
              id,
              `${docker(plan.elevation)} image inspect --format '{{.Id}}' ${q(image)}`,
              30000,
              signal,
            )
          ).trim()
          if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
            throw new AppError('SERVICE_ERROR', 'The release image identity was not verified.')
          expectedImages[service] = imageId
        }
      }
      signal.throwIfAborted()
      const beforeActivation = await this.inspect(id, record, plan.elevation)
      if (
        beforeActivation.configHash !== plan.configHash ||
        beforeActivation.blocked.length ||
        (record.config.compose?.services ?? []).some(
          (name) =>
            beforeActivation.containers.find((c) => c.service === name)?.id !==
            inspected.containers.find((c) => c.service === name)?.id,
        )
      )
        throw new AppError(
          'FILE_CONFLICT',
          'Runtime configuration or application containers changed while building. Activation was stopped.',
        )
      if (record.config.strategy === 'static') {
        const current = await this.io.manifest(id, plan.baseline, plan.protectedPaths, signal)
        if (
          manifestHash(current.files) !== manifestHash(plan.current.files) ||
          JSON.stringify(current.skipped) !== JSON.stringify(plan.current.skipped)
        )
          throw new AppError(
            'FILE_CONFLICT',
            'The document root changed during staging. Publication was stopped.',
          )
      }
      // Cancellation is disabled from this point: a service transition must finish or be recovered explicitly.
      run.progress.cancellable = false
      this.report(
        run,
        'Activating release',
        'Only the selected application is being switched. Databases and unselected services are retained.',
      )
      const adapter = websiteAdapter(record.config)
      const nextRecord = {
        ...record,
        activeRelease: release,
        activeOverride: override,
        updatedAt: new Date().toISOString(),
      }
      if (adapter.activationMayPartiallySucceed) await this.repository.saveRecord(nextRecord)
      activated = true
      await adapter.activate({
        sessionId: id,
        record,
        release,
        originalBackup: childPath(backupRoot, 'original'),
        override,
        elevation: plan.elevation,
        io: this.io,
        sessions: this.sessions,
      })
      if (!adapter.activationMayPartiallySucceed) await this.repository.saveRecord(nextRecord)
      this.report(run, 'Checking application health')
      let health: HealthResult | undefined
      let runtimeHealthy = record.config.strategy === 'static'
      const deadline = Date.now() + record.config.healthTimeoutSeconds * 1000
      do {
        health = await this.health(id, record.id)
        if (record.config.strategy === 'compose') {
          const actual = (await this.discovery.containers(id, plan.elevation)).filter(
            (c) =>
              c.project === record.config.compose!.project &&
              c.directory === record.config.projectPath,
          )
          runtimeHealthy = Object.entries(expectedImages).every(([name, image]) => {
            const selected = actual.filter((c) => c.service === name)
            return (
              selected.length === 1 &&
              selected[0].image === image &&
              selected[0].state === 'running' &&
              !['unhealthy', 'starting'].includes(selected[0].health || '')
            )
          })
        }
        if (health.state === 'healthy' && runtimeHealthy) break
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000))
      } while (Date.now() < deadline)
      if (health?.state !== 'healthy' || !runtimeHealthy)
        throw new AppError(
          'SERVICE_ERROR',
          'The selected release did not pass runtime and application health checks. Use the verified application backup to restore; databases are untouched by the restore workflow.',
        )
      this.report(run, 'Verifying website routing')
      const routing = await this.checkUrl(id, record.config.publicUrl)
      if (routing.state !== 'healthy')
        throw new AppError(
          'SERVICE_ERROR',
          'Application health passed, but public website routing did not verify. Inspect routing or restore the application backup.',
        )
      history.status = plan.restore ? 'restored' : 'completed'
      history.message =
        'Application runtime, health and configured public routing verified from the server. Database state was not restored.'
    } catch (error) {
      history.status = run.interrupted
        ? 'interrupted'
        : signal.aborted && !activated
          ? 'cancelled'
          : 'failed'
      history.message =
        mapError(error, 'websites.deploy').message +
        (activated
          ? ' Activation began; inspect runtime state before recovery.'
          : ' The published application was not switched.')
    } finally {
      history.endedAt = new Date().toISOString()
      run.progress.finishedAt = history.endedAt
      run.progress.state = history.status
      run.progress.cancellable = false
      this.report(run, history.status, history.message)
      history.log = [...run.progress.log]
      await this.repository.saveHistory(history)
      if (this.running.size > 100)
        for (const [key, value] of this.running)
          if (value.progress.state !== 'running' && key !== history.id) {
            this.running.delete(key)
            break
          }
    }
  }
  async restore(
    id: string,
    websiteId: string,
    historyId: string,
    elevation: Elevation,
  ): Promise<string | null> {
    const record = this.record(id, websiteId),
      history = this.history(id, websiteId).find((h) => h.id === historyId)
    this.free(id, record)
    if (
      !history?.backupVerified ||
      !history.backupPath ||
      !history.backupPath.startsWith(childPath(this.storage(record), 'backups') + '/')
    )
      throw new AppError(
        'INVALID_REQUEST',
        'This entry has no verified application restoration point.',
      )
    const inspected = await this.inspect(id, record, elevation)
    if (inspected.configHash !== history.configHash || inspected.blocked.length)
      throw new AppError(
        'FILE_CONFLICT',
        'The runtime mapping changed. Automatic application restore is unsafe.',
      )
    const source: ProjectSource = { kind: 'remote', root: history.backupPath }
    const incoming = await this.io.manifest(id, source, inspected.protectedPaths)
    if (manifestHash(incoming.files) !== history.backupHash)
      throw new AppError('FILE_CONFLICT', 'The backup content changed or is incomplete.')
    for (const image of Object.values(history.previousImages))
      await this.sessions.exec(
        id,
        `${docker(elevation)} image inspect --format '{{.Id}}' ${q(image)}`,
      )
    const baseline = await this.baseline(id, record),
      current = await this.io.manifest(id, baseline, inspected.protectedPaths)
    this.free(id, record)
    const lock = this.lockKey(id, record)
    this.locks.add(lock)
    try {
      if (
        !(await this.confirm(
          'Restore application',
          `Restore the application backup for ${record.config.domain}?`,
          `Backup: ${history.startedAt}\n${incoming.files.length} source files; selected services: ${record.config.compose?.services.join(', ') || 'static assets'}\n\nThis restores application source/images only. Databases, current user data, media, environment variables and certificates are never restored. The previous application may be incompatible with the current database schema. The current application is backed up first.`,
        ))
      )
        return null
      const preview: DeploymentPreview = {
        token: randomUUID(),
        websiteId,
        expiresAt: Date.now() + 60000,
        method: 'full',
        changes: compareFiles(current.files, incoming.files, 'full'),
        bytes: incoming.bytes,
        fileCount: incoming.files.length,
        services: record.config.compose?.services ?? [],
        protected: incoming.skipped,
        blocked: [],
        warnings: [],
        freeBytes: 0,
      }
      return await this.start(
        {
          sessionId: id,
          record,
          baseline,
          current,
          source,
          incoming,
          preview,
          elevation,
          ...inspected,
          restore: history,
        },
        lock,
      )
    } finally {
      if (
        ![...this.running.values()].some((r) => r.lock === lock && r.progress.state === 'running')
      )
        this.locks.delete(lock)
    }
  }
  private async checkUrl(id: string, url: string): Promise<HealthResult> {
    const at = new Date().toISOString()
    try {
      const code = Number((await this.sessions.exec(id, healthCommand(url), 20000)).trim())
      return {
        at,
        url,
        code,
        state: code >= 200 && code < 400 ? 'healthy' : 'unhealthy',
        detail: `HTTP ${code || 'unknown'} from the server; redirects are not followed.`,
      }
    } catch {
      return {
        at,
        url,
        state: 'unreachable',
        detail:
          'The server could not verify this HTTP(S) endpoint. Check connectivity, TLS, routing and permissions.',
      }
    }
  }
  async health(id: string, websiteId: string): Promise<HealthResult> {
    return this.checkUrl(id, this.record(id, websiteId).config.healthUrl)
  }
  async logs(id: string, websiteId: string, elevation: Elevation): Promise<string> {
    const record = this.record(id, websiteId)
    if (record.config.strategy !== 'compose')
      return 'Application logs are available for registered Compose services. Deployment logs are in History.'
    const model = parseComposeModel(
      await this.sessions.exec(id, composeAction(record.config, elevation, 'config')),
    )
    const lines: string[] = []
    const sanitizer = new DeploymentLogSanitizer((line) => lines.push(line), composeSecrets(model))
    sanitizer.feed(
      await this.sessions.exec(
        id,
        composeAction(record.config, elevation, 'logs', record.activeOverride),
        20000,
      ),
    )
    sanitizer.flush()
    return lines.slice(-150).join('\n')
  }
  async restart(id: string, websiteId: string, elevation: Elevation): Promise<void> {
    const record = this.record(id, websiteId)
    this.free(id, record)
    if (record.config.strategy !== 'compose')
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Only mapped Compose application services support restart.',
      )
    const inspected = await this.inspect(id, record, elevation)
    if (inspected.blocked.length)
      throw new AppError('PERMISSION_DENIED', inspected.blocked.join(' '))
    this.free(id, record)
    const lock = this.lockKey(id, record)
    this.locks.add(lock)
    try {
      if (
        await this.confirm(
          'Restart website',
          `Restart ${record.config.domain}?`,
          `Only ${record.config.compose!.services.join(', ')} will be restarted. Database/dependency services are not restarted. Authorization: ${elevation}.`,
        )
      )
        await this.sessions.exec(
          id,
          composeAction(record.config, elevation, 'restart', record.activeOverride),
          60000,
        )
    } finally {
      this.locks.delete(lock)
    }
  }
  async nginxDiagnostic(id: string, reload: boolean, elevation: Elevation): Promise<string> {
    const test = `LC_ALL=C ${elevation === 'sudo' ? 'sudo -n -- /usr/sbin/nginx' : 'nginx'} -t`
    if (
      reload &&
      !(await this.confirm(
        'Reload Nginx',
        'Reload the shared Nginx service after validating its configuration?',
        'This is a shared service operation and may affect all hosted websites. No configuration or certificate files are edited.',
      ))
    )
      return 'Reload cancelled.'
    await this.sessions.exec(id, test, 20000)
    if (reload)
      await this.sessions.exec(
        id,
        `LC_ALL=C ${elevation === 'sudo' ? 'sudo -n -- /usr/bin/systemctl' : 'systemctl'} --no-ask-password reload nginx.service`,
        30000,
      )
    return reload
      ? 'Nginx configuration tested and service reload completed.'
      : 'Nginx configuration test passed. No reload performed.'
  }
}
