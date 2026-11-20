import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, posix } from 'node:path'
import type { AppEvent, Outputs, Result } from '../../shared/contracts/api'
import { schemas, type Input, type Route } from '../../shared/schemas'
import { AppError, mapError } from '../../domain/errors/app-error'
import { SettingsRepository } from '../../infrastructure/persistence/store'
import { WorkspaceRepository } from '../../infrastructure/persistence/workspace'
import { RemoteFs } from '../../infrastructure/sftp/remote-fs'
import { CredentialVault } from '../../infrastructure/credentials/vault'
import { Logger } from '../../infrastructure/logging/logger'
import { SessionManager } from '../session/session-manager'
import { FileOperations, type Confirm } from '../../application/filesystem/file-operations'
import { TransferManager, type ResolveConflict } from '../../application/transfers/transfer-manager'
import { TerminalManager } from '../../application/terminal/terminal-manager'
import { Monitoring } from '../../application/monitoring/monitoring'
import { ApplicationManager } from '../../application/applications/application-manager'
import { WebsiteManager } from '../../application/websites/website-manager'
import { WebsiteRepository } from '../../infrastructure/persistence/websites'
import {
  logsCommand,
  portsCommand,
  processesCommand,
  serviceActionCommand,
  serviceDetailsCommand,
  servicesCommand,
} from '../../infrastructure/commands/catalog'
import { trustedSender } from '../security/origin'
import { quotePosix } from '../../domain/filesystem/policy'

type Handlers = { [K in Route]: (input: Input<K>) => Promise<Outputs[K]> | Outputs[K] }
export async function registerApi(
  window: BrowserWindow,
  expectedUrl: string,
  repository: SettingsRepository,
): Promise<{
  dispose: () => void
  sessions: SessionManager
  transfers: TransferManager
  websites: WebsiteManager
  flush: () => Promise<void>
  dirtyCount: () => number
}> {
  const workspace = new WorkspaceRepository(app.getPath('userData'))
  const savedWorkspace = await workspace.load()
  let dirtyEditors = 0
  const vault = new CredentialVault()
  const logger = new Logger(app.getPath('logs'))
  await mkdir(logger.directory, { recursive: true })
  const emit = (event: AppEvent): void => {
    if (
      event.type === 'session' &&
      ['DISCONNECTED', 'CONNECTION_LOST'].includes(event.session.state)
    ) {
      transfers?.cancelSession(event.session.id)
      websites?.disconnect(event.session.id)
    }
    if (!window.isDestroyed()) window.webContents.send('vps:event', event)
  }
  const sessions = new SessionManager(repository, vault, emit)
  const confirm: Confirm = async (title, message, detail) =>
    (
      await dialog.showMessageBox(window, {
        type: 'warning',
        title,
        message,
        detail: detail.slice(0, 12000),
        buttons: ['Cancel', title],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1
  let conflictDialogs: Promise<unknown> = Promise.resolve()
  const conflict: ResolveConflict = (path) => {
    const answer = conflictDialogs.then(async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'File already exists',
        message: 'Choose how to handle the existing file.',
        detail: path,
        buttons: ['Cancel batch', 'Skip', 'Replace', 'Keep both'],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: 'Apply to remaining conflicts in this batch',
        noLink: true,
      })
      return {
        policy: (['cancel', 'skip', 'replace', 'keep-both'] as const)[result.response],
        all: result.checkboxChecked,
      }
    })
    conflictDialogs = answer.catch(() => {})
    return answer
  }
  const files = new FileOperations(sessions, confirm)
  const transfers = new TransferManager(sessions, emit, conflict)
  transfers.setConcurrency(repository.preferences().concurrency)
  const terminals = new TerminalManager(sessions, emit)
  const monitoring = new Monitoring(sessions)
  const applications = new ApplicationManager(sessions, repository, confirm, emit)
  const websiteRepository = new WebsiteRepository(app.getPath('userData'))
  // Corrupt feature metadata disables Websites; other desktop apps remain available.
  await websiteRepository.load().catch(() => {})
  const websites = new WebsiteManager(sessions, websiteRepository, confirm, emit)
  const websiteSources = new Map<
    string,
    { sessionId: string; path: string; zip: boolean; expires: number }
  >()
  const capabilities = new Map<string, { path: string; kind: 'key' | 'upload'; expires: number }>()
  const grant = (path: string, kind: 'key' | 'upload'): string => {
    const token = randomUUID()
    capabilities.set(token, { path, kind, expires: Date.now() + 30 * 60000 })
    return token
  }
  const consume = (token: string, kind: 'key' | 'upload'): string => {
    const c = capabilities.get(token)
    if (kind === 'upload') capabilities.delete(token)
    if (!c || c.kind !== kind || c.expires < Date.now())
      throw new AppError(
        'INVALID_REQUEST',
        'The selected file authorization expired. Select it again.',
      )
    return c.path
  }
  const handlers: Handlers = {
    'websites.discover': (p) => websites.discover(p.sessionId, p.elevation),
    'websites.save': (p) => websites.register(p.sessionId, p.config, p.websiteId),
    'websites.pickSource': async (p) => {
      sessions.get(p.sessionId)
      const r = await dialog.showOpenDialog(window, {
        title:
          p.kind === 'folder' ? 'Select the project source folder' : 'Select a project ZIP archive',
        properties: [p.kind === 'folder' ? 'openDirectory' : 'openFile'],
        ...(p.kind === 'zip' ? { filters: [{ name: 'ZIP archives', extensions: ['zip'] }] } : {}),
      })
      if (r.canceled || !r.filePaths[0]) return null
      const selected = await realpath(r.filePaths[0]),
        attrs = await lstat(selected)
      if (attrs.isSymbolicLink() || (p.kind === 'folder' ? !attrs.isDirectory() : !attrs.isFile()))
        throw new AppError('INVALID_PATH', 'Choose a regular folder or ZIP archive.')
      for (const [token, value] of websiteSources)
        if (value.expires < Date.now()) websiteSources.delete(token)
      if (websiteSources.size >= 100)
        throw new AppError('INVALID_REQUEST', 'Too many source pickers are open.')
      const token = randomUUID()
      websiteSources.set(token, {
        sessionId: p.sessionId,
        path: selected,
        zip: p.kind === 'zip',
        expires: Date.now() + 30 * 60000,
      })
      return { token, name: basename(selected) }
    },
    'websites.prepare': (p) => {
      let local: { path: string; zip: boolean } | undefined
      if (p.source.kind === 'local') {
        const grant = websiteSources.get(p.source.token)
        if (!grant || grant.sessionId !== p.sessionId || grant.expires < Date.now())
          throw new AppError(
            'INVALID_REQUEST',
            'The source authorization expired or belongs to another connection. Select it again.',
          )
        local = grant
      }
      return websites.prepare(
        p.sessionId,
        p.websiteId,
        p.method,
        p.source,
        p.elevation,
        p.paths,
        local,
      )
    },
    'websites.discard': (p) => websites.discard(p.sessionId, p.token),
    'websites.deploy': (p) => websites.deploy(p.sessionId, p.token, p.acknowledged),
    'websites.cancel': (p) => websites.cancel(p.sessionId, p.operationId),
    'websites.operations': (p) => websites.operations(p.sessionId),
    'websites.history': (p) => websites.history(p.sessionId, p.websiteId),
    'websites.health': (p) => websites.health(p.sessionId, p.websiteId),
    'websites.logs': (p) => websites.logs(p.sessionId, p.websiteId, p.elevation),
    'websites.restart': (p) => websites.restart(p.sessionId, p.websiteId, p.elevation),
    'websites.restore': (p) => websites.restore(p.sessionId, p.websiteId, p.historyId, p.elevation),
    'websites.nginx': (p) => websites.nginxDiagnostic(p.sessionId, p.reload, p.elevation),
    'clipboard.readText': () => clipboard.readText(),
    'clipboard.writeText': (p) => clipboard.writeText(p.text),
    'workspace.load': () => savedWorkspace,
    'workspace.save': async (p) => {
      await workspace.save(p)
      savedWorkspace.layout = p
    },
    'app.editorState': (p) => {
      dirtyEditors = p.dirtyCount
    },
    'app.bootstrap': async () => ({
      profiles: repository.profiles(),
      preferences: repository.preferences(),
      trustedHosts: repository.hosts(),
      sessions: sessions.list(),
      transfers: transfers.list(),
      secureStorage: await vault.available(),
      version: app.getVersion(),
    }),
    'app.preferences': async (p) => {
      await repository.updatePreferences(p)
      transfers.setConcurrency(p.concurrency)
      return p
    },
    'app.diagnostics': async () => {
      const result = await shell.openPath(logger.directory)
      if (result)
        throw new AppError('FILE_NOT_FOUND', 'The diagnostics directory could not be opened.')
    },
    'profiles.remove': async (p) => {
      await repository.removeProfile(p.id)
    },
    'profiles.forgetCredentials': async (p) => {
      await repository.saveCredential(p.id)
    },
    'connection.connect': async (p) =>
      sessions.connect(p, p.keyToken ? consume(p.keyToken, 'key') : undefined),
    'connection.disconnect': (p) => {
      transfers.cancelSession(p.sessionId)
      sessions.disconnect(p.sessionId)
    },
    'connection.cancel': () => sessions.cancel(),
    'connection.trust': (p) => sessions.trust(p.id, p.accept),
    'connection.pickKey': async () => {
      const r = await dialog.showOpenDialog(window, {
        title: 'Select SSH private key',
        properties: ['openFile'],
      })
      if (r.canceled || !r.filePaths[0]) return null
      return { token: grant(r.filePaths[0], 'key'), name: basename(r.filePaths[0]) }
    },
    'files.list': async (p) => {
      const result = await files.fs(p.sessionId).list(p.path)
      const s = sessions.get(p.sessionId)
      const saved = repository.profiles().find((v) => v.id === s.info.profile.id)
      if (saved && saved.lastDirectory !== result.path)
        await repository.saveProfile({ ...saved, lastDirectory: result.path })
      return result
    },
    'files.stat': (p) => files.fs(p.sessionId).stat(p.path),
    'files.cancel': (p) => {
      sessions.get(p.sessionId)
      files.cancel(p.sessionId)
    },
    'files.resolve': async (p) => {
      const fs = files.fs(p.sessionId)
      return fs.stat(await fs.realpath(p.path))
    },
    'files.create': (p) =>
      files.exclusive(p.sessionId, () => files.create(p.sessionId, p.path, p.name, p.kind)),
    'files.rename': (p) =>
      files.exclusive(p.sessionId, () => files.fs(p.sessionId).rename(p.path, p.destination)),
    'files.copy': (p) =>
      files.exclusive(p.sessionId, (signal) =>
        files.copy(p.sessionId, p.paths, p.destination, signal),
      ),
    'files.delete': (p) =>
      files.exclusive(p.sessionId, (signal) => files.delete(p.sessionId, p.paths, signal)),
    'files.chmod': (p) =>
      files.exclusive(p.sessionId, () => files.chmod(p.sessionId, p.path, p.mode)),
    'files.read': (p) => files.fs(p.sessionId).text(p.path),
    'files.save': (p) =>
      files.exclusive(p.sessionId, () => files.fs(p.sessionId).save(p.path, p.content, p.identity)),
    'transfers.upload': async (p) => {
      sessions.get(p.sessionId)
      const r = await dialog.showOpenDialog(window, {
        title: `Upload ${p.folders ? 'folders' : 'files'} to ${p.path}`,
        properties: [p.folders ? 'openDirectory' : 'openFile', 'multiSelections'],
      })
      if (!r.canceled) await transfers.upload(p.sessionId, r.filePaths, p.path, p.conflict)
    },
    'transfers.drop': (p) =>
      transfers.upload(
        p.sessionId,
        p.tokens.map((t) => consume(t, 'upload')),
        p.path,
        p.conflict,
      ),
    'transfers.desktopDrop': async (p) => {
      // Only this conventional home subfolder may be created by a desktop drop.
      const home = sessions.get(p.sessionId).info.home
      const localPaths = p.tokens.map((t) => consume(t, 'upload'))
      if (p.path === posix.join(home, 'Uploads'))
        await new RemoteFs(sessions.fs(p.sessionId)).ensureDirectory(p.path)
      await transfers.upload(p.sessionId, localPaths, p.path, p.conflict)
    },
    'transfers.download': async (p) => {
      sessions.get(p.sessionId)
      const r = await dialog.showOpenDialog(window, {
        title: 'Download selected entries to…',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (!r.canceled && r.filePaths[0])
        await transfers.download(p.sessionId, p.paths, r.filePaths[0], p.conflict)
    },
    'transfers.cancel': (p) => transfers.cancel(p.id),
    'transfers.retry': (p) => transfers.retry(p.id),
    'transfers.reveal': (p) => {
      const j = transfers.get(p.id)
      if (j.direction !== 'download' || j.status !== 'COMPLETED')
        throw new AppError('INVALID_REQUEST', 'Only completed downloads can be revealed.')
      shell.showItemInFolder(j.localPath)
    },
    'terminal.open': (p) => terminals.open(p.sessionId, p.cols, p.rows, p.cwd),
    'terminal.input': (p) => terminals.input(p.id, p.data),
    'terminal.resize': (p) => terminals.resize(p.id, p.cols, p.rows),
    'terminal.ack': (p) => terminals.ack(p.id, p.bytes),
    'terminal.close': (p) => terminals.close(p.id),
    'monitoring.get': (p) => monitoring.get(p.sessionId),
    'services.list': async (p) =>
      (await sessions.exec(p.sessionId, servicesCommand))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, load, active, sub, ...description] = line.trim().split(/\s+/)
          return { name, load, active, sub, description: description.join(' ') }
        }),
    'services.details': (p) => sessions.exec(p.sessionId, serviceDetailsCommand(p.name)),
    'services.action': async (p) => {
      const sensitive = /ssh|network|firewall|ufw|postgres|mysql|maria|systemd|dbus/.test(p.name)
      if (
        !(await confirm(
          'Apply service action',
          `${p.action} ${p.name}?`,
          `${sensitive ? 'This is a sensitive service. The action may interrupt connectivity, databases, or the operating system.\n\n' : ''}Only the authenticated account’s existing permissions will be used. No sudo or elevation.`,
        ))
      )
        return
      await sessions.exec(p.sessionId, serviceActionCommand(p.name, p.action), 30000)
      await sessions.exec(p.sessionId, serviceDetailsCommand(p.name))
    },
    'logs.read': (p) => sessions.exec(p.sessionId, logsCommand(p.name)),
    'system.processes': (p) => sessions.exec(p.sessionId, processesCommand),
    'applications.packages': (p) => applications.packages(p.sessionId),
    'applications.deployments': (p) => applications.deployments(p.sessionId),
    'applications.saveDeployment': (p) =>
      applications.saveDeployment(p.sessionId, p.deployment, p.id),
    'applications.forgetDeployment': (p) => applications.forgetDeployment(p.sessionId, p.id),
    'applications.prepareRemoval': (p) => applications.prepare(p.sessionId, p.kind, p.target),
    'applications.executeRemoval': (p) => applications.execute(p.sessionId, p.token, p.elevation),
    'system.inspect': async (p) => {
      const output = await sessions.exec(
        p.sessionId,
        `LC_ALL=C ps -p ${p.pid} -o pid,user,pcpu,pmem,etime,args; printf '\\n__START__\\n'; sed 's/.*) //' /proc/${p.pid}/stat | cut -d ' ' -f 20`,
      )
      const [detail, start] = output.split('\n__START__\n')
      const startTime = start?.trim()
      if (!startTime || !/^\d+$/.test(startTime))
        throw new AppError(
          'FILE_NOT_FOUND',
          'The process exited or its identity could not be read.',
        )
      return { pid: p.pid, startTime, detail }
    },
    'system.ports': (p) => sessions.exec(p.sessionId, portsCommand),
    'system.terminate': async (p) => {
      if (
        !(await confirm(
          'Terminate process',
          `Send SIGTERM to process ${p.pid}?`,
          'The account must have permission. Confirm the process identity and start time using Terminal before continuing.',
        ))
      )
        return
      const command = `p=/proc/${p.pid}/stat; test -r "$p" && s=$(sed 's/.*) //' "$p" | cut -d ' ' -f 20) && test "$s" = ${quotePosix(p.startTime)} && kill -TERM -- ${p.pid}`
      await sessions.exec(p.sessionId, command)
    },
    'shell.openExternal': async (p) => {
      const url = new URL(p.url)
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new AppError('INVALID_REQUEST', 'Only HTTP and HTTPS links can be opened.')
      if (await confirm('Open link', 'Open this terminal link in your browser?', url.href))
        await shell.openExternal(url.href)
    },
  }
  const authorized = (event: IpcMainInvokeEvent): void => {
    if (!trustedSender(event, window, expectedUrl))
      throw new AppError('INVALID_REQUEST', 'IPC request origin was rejected.')
  }
  ipcMain.handle(
    'vps:invoke',
    async (event, route: unknown, input: unknown): Promise<Result<unknown>> => {
      try {
        authorized(event)
        if (typeof route !== 'string' || !Object.hasOwn(schemas, route))
          throw new AppError('INVALID_REQUEST', 'Unknown operation.')
        const parsed = schemas[route as Route].safeParse(input)
        if (!parsed.success)
          throw new AppError(
            'INVALID_REQUEST',
            'Invalid request. Check all input fields.',
            'Use valid paths, names, and connection settings.',
          )
        // Schema and handler maps share the same Route key; correlation is established above.
        const handler = handlers[route as Route] as (value: unknown) => unknown
        return { ok: true, value: await handler(parsed.data) }
      } catch (error) {
        const e = mapError(
          error,
          typeof route === 'string' && Object.hasOwn(schemas, route) ? route : 'ipc',
        )
        logger.error(e)
        return { ok: false, error: e }
      }
    },
  )
  ipcMain.handle('vps:drop', async (event, paths: unknown): Promise<string[]> => {
    authorized(event)
    if (!Array.isArray(paths) || paths.length > 1000)
      throw new AppError('INVALID_REQUEST', 'Invalid dropped files.')
    return Promise.all(
      paths.map(async (p) => {
        if (
          typeof p !== 'string' ||
          !isAbsolute(p) ||
          (!(await lstat(p)).isFile() && !(await lstat(p)).isDirectory())
        )
          throw new AppError('INVALID_PATH', 'Invalid dropped file.')
        return grant(p, 'upload')
      }),
    )
  })
  return {
    flush: async () => {
      await Promise.all([workspace.flush(), websiteRepository.flush()])
    },
    dirtyCount: () => dirtyEditors,
    sessions,
    transfers,
    websites,
    dispose: () => {
      transfers.cancelAll()
      websites.dispose()
      sessions.dispose()
      ipcMain.removeHandler('vps:invoke')
      ipcMain.removeHandler('vps:drop')
    },
  }
}
