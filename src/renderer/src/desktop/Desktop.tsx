import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import {
  ArrowDownUp,
  ChevronDown,
  Folder,
  Grid2X2,
  LogOut,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Upload,
  X,
  Pin,
  Monitor,
  FileCode2,
} from 'lucide-react'
import type { ServerSession } from '../../../domain/connection/types'
import type { AppId } from '../../../shared/workspace'
import { useApp, type Module } from '../app/store'
import { rpc, errorText } from '../app/api'
import { IconButton, Loading, Modal } from '../components/ui'
import { Explorer } from '../features/explorer/Explorer'
import { Overview } from '../features/dashboard/Overview'
import { Services } from '../features/services/Services'
import { ServerOutput } from '../features/services/ServerOutput'
import { Transfers } from '../features/transfers/Transfers'
import { apps } from './registry'
import { useDesktop, type DesktopWindow } from './store'
import { WindowFrame } from './WindowFrame'
import './desktop.css'

const Terminals = lazy(() =>
  import('../features/terminal/Terminal').then((m) => ({ default: m.Terminals })),
)
const Editor = lazy(() => import('../features/editor/Editor').then((m) => ({ default: m.Editor })))
const Applications = lazy(() =>
  import('../features/applications/Applications').then((m) => ({ default: m.Applications })),
)
const Settings = lazy(() =>
  import('../features/settings/Settings').then((m) => ({ default: m.Settings })),
)
type ServerTab = 'overview' | 'services' | 'monitoring' | 'logs'
type TerminalRequest = { id: string; cwd: string }

function WindowApp({
  w,
  session,
  visible,
  focused,
  request,
  openTerminal,
  navigate,
}: {
  w: DesktopWindow
  session?: ServerSession
  visible: boolean
  focused: boolean
  request?: TerminalRequest
  openTerminal: (s: ServerSession, cwd: string) => void
  navigate: (module: Module, s: ServerSession) => void
}) {
  const client = useQueryClient()
  const [tab, setTab] = useState<ServerTab>('overview')
  const dirty = useCallback((value: boolean) => useDesktop.getState().dirty(w.id, value), [w.id])
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; tab: ServerTab }>).detail
      if (detail.id === w.id) setTab(detail.tab)
    }
    window.addEventListener('vps:server-tab', listener)
    return () => window.removeEventListener('vps:server-tab', listener)
  }, [w.id])
  if (w.app === 'settings') return <Settings />
  if (!session) return null
  const online = session.state === 'CONNECTED'
  return (
    <>
      {!online && (
        <div className="window-offline" role="status">
          Connection closed. Reconnect to use this server.{' '}
          {w.app === 'editor' && 'Your local edits are kept in this window.'}
        </div>
      )}
      <div
        className={`window-app-content ${w.app === 'terminal' ? 'terminal-app' : ''}`}
        inert={!online && w.app !== 'editor'}
      >
        {w.app === 'files' && (
          <Explorer
            session={session}
            active={visible && online}
            openTerminal={(cwd) => openTerminal(session, cwd)}
            openEditor={(path) => useDesktop.getState().open('editor', session, path)}
          />
        )}
        {w.app === 'terminal' && w.started && (
          <Terminals
            session={session}
            active={visible && online}
            focused={focused && online}
            request={request}
          />
        )}
        {w.app === 'editor' && (
          <Editor
            sessionId={session.id}
            path={w.path!}
            embedded
            connected={online}
            onDirtyChange={dirty}
            onClose={() => useDesktop.getState().close(w.id)}
            onSaved={() => void client.invalidateQueries({ queryKey: ['directory', session.id] })}
          />
        )}
        {w.app === 'transfers' && <Transfers sessionId={session.id} />}
        {w.app === 'applications' && (
          <Applications
            sessionId={session.id}
            active={visible && online}
            openTerminal={(cwd) => openTerminal(session, cwd)}
          />
        )}
        {w.app === 'server' && (
          <div className="server-app">
            <nav className="server-tabs" aria-label="Server tools">
              {(['overview', 'services', 'monitoring', 'logs'] as const).map((id) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                  {id[0].toUpperCase() + id.slice(1)}
                </button>
              ))}
            </nav>
            {
              <div className="server-tab-content">
                {(tab === 'overview' || tab === 'monitoring') && (
                  <Overview
                    active={visible && online}
                    session={session}
                    monitoring={tab === 'monitoring'}
                    onNavigate={(module) =>
                      module === 'services' ? setTab('services') : navigate(module, session)
                    }
                  />
                )}
                {tab === 'services' && (
                  <Services sessionId={session.id} active={visible && online} />
                )}
                {tab === 'logs' && (
                  <ServerOutput sessionId={session.id} module="logs" active={visible && online} />
                )}
              </div>
            }
          </div>
        )}
      </div>
    </>
  )
}

export function Desktop({
  onConnect,
  onDisconnect,
}: {
  onConnect: () => void
  onDisconnect: () => void
}) {
  const sessions = useApp((s) => s.sessions)
  const activeId = useApp((s) => s.activeId)
  const activeTransfers = useApp(
    (s) =>
      s.jobs.filter(
        (j) =>
          j.sessionId === s.activeId && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status),
      ).length,
  )
  const session = sessions.find((s) => s.id === activeId)
  const windows = useDesktop((s) => s.windows)
  const activeWindow = useDesktop((s) => s.activeWindow)
  const layout = useDesktop((s) => s.layout)
  const ready = useDesktop((s) => s.ready)
  const warning = useDesktop((s) => s.warning)
  const canvas = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ width: window.innerWidth, height: window.innerHeight - 104 })
  const [launcher, setLauncher] = useState(false)
  const [search, setSearch] = useState('')
  const [clock, setClock] = useState(new Date())
  const [dragging, setDragging] = useState(false)
  const [drop, setDrop] = useState<{
    sessionId: string
    name: string
    path: string
    files: File[]
  }>()
  const [uploading, setUploading] = useState(false)
  const [requests, setRequests] = useState<Record<string, TerminalRequest>>({})
  const attached = useRef(new Set<string>())
  const opened = windows.filter((w) => !w.sessionId || w.sessionId === activeId)
  const online = session?.state === 'CONNECTED'
  const open = (app: AppId) => {
    if (!session && app !== 'settings') return
    useDesktop.getState().open(app, session)
    setLauncher(false)
  }
  const openTerminal = (s: ServerSession, cwd: string) => {
    setRequests((r) => ({ ...r, [s.id]: { id: crypto.randomUUID(), cwd } }))
    useDesktop.getState().open('terminal', s)
  }
  const navigate = (module: Module, s: ServerSession) => {
    if (['overview', 'services', 'monitoring', 'logs'].includes(module)) {
      const id = useDesktop.getState().open('server', s)
      // Existing server windows already own their selected tab.
      window.dispatchEvent(new CustomEvent('vps:server-tab', { detail: { id, tab: module } }))
    } else useDesktop.getState().open(module as AppId, s)
  }
  useEffect(() => {
    let cancelled = false
    void rpc('workspace.load', {})
      .then((result) => {
        if (!cancelled) useDesktop.getState().hydrate(result.layout, result.warning)
      })
      .catch((e) => {
        if (!cancelled) useApp.getState().set({ error: errorText(e) })
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!ready) return
    for (const s of sessions)
      if (s.state === 'CONNECTED' && !attached.current.has(s.id)) {
        attached.current.add(s.id)
        useDesktop.getState().attach(s)
      }
  }, [ready, sessions])
  useEffect(() => {
    if (ready && !warning)
      void rpc('workspace.save', layout).catch((e) =>
        useApp.getState().set({ error: errorText(e) }),
      )
  }, [layout, ready, warning])
  const dirtyCount = windows.filter((w) => w.dirty).length
  useEffect(() => {
    void rpc('app.editorState', { dirtyCount }).catch(() => {})
  }, [dirtyCount])
  useEffect(() => {
    if (!canvas.current) return
    const observer = new ResizeObserver(([entry]) =>
      setArea({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 10000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch('')
        setLauncher((v) => !v)
      }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const visible = useDesktop
          .getState()
          .windows.filter(
            (w) => (!w.sessionId || w.sessionId === activeId) && w.mode !== 'minimized',
          )
        visible.forEach((w) => useDesktop.getState().minimize(w.id))
      }
      if (e.ctrlKey && e.key === 'F6') {
        e.preventDefault()
        const list = useDesktop
          .getState()
          .windows.filter((w) => !w.sessionId || w.sessionId === activeId)
          .toSorted((a, b) => a.order - b.order)
        if (list.length) useDesktop.getState().focus(list[0].id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeId])
  const closeWindow = (w: DesktopWindow) => {
    if (w.dirty && !window.confirm('Discard unsaved changes in this file?')) return
    if (
      w.app === 'terminal' &&
      w.started &&
      !window.confirm('Close Terminal and end its open shell sessions?')
    )
      return
    useDesktop.getState().close(w.id)
    if (w.app === 'terminal' && w.sessionId)
      setRequests((r) => {
        const next = { ...r }
        delete next[w.sessionId!]
        return next
      })
  }
  const uploadDrop = async () => {
    if (!drop || uploading) return
    const destination = drop
    setUploading(true)
    try {
      const tokens = await window.vps.droppedFiles(destination.files)
      await rpc('transfers.desktopDrop', {
        sessionId: destination.sessionId,
        path: destination.path,
        tokens,
        conflict: 'ask',
      })
      const target = useApp.getState().sessions.find((s) => s.id === destination.sessionId)
      if (target) {
        useApp.getState().set({ activeId: target.id })
        useDesktop.getState().open('transfers', target)
      }
      setDrop(undefined)
    } catch (e) {
      useApp.getState().set({ error: errorText(e) })
    } finally {
      setUploading(false)
    }
  }
  const taskApps = [
    ...new Set([
      ...layout.pinned,
      ...opened.filter((w) => w.app !== 'editor').map((w) => w.app as AppId),
    ]),
  ]
  return (
    <div className="os-desktop">
      <div className="desktop-wallpaper" aria-hidden="true">
        <div className="wallpaper-orbit orbit-one" />
        <div className="wallpaper-orbit orbit-two" />
        <div className="wallpaper-orbit orbit-three" />
      </div>
      <header className="os-titlebar">
        <span className="titlebar-logo">
          <Grid2X2 size={16} /> VPS Manager
        </span>
        <span>YOUR SERVER WORKSPACE</span>
      </header>
      <main
        className="desktop-canvas"
        ref={canvas}
        aria-label="Server desktop"
        onDragOverCapture={(e) => {
          if ((e.target as HTMLElement).closest('.os-window')) setDragging(false)
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          if ((e.target as HTMLElement).closest('.os-window')) {
            e.dataTransfer.dropEffect = 'none'
            return
          }
          e.dataTransfer.dropEffect = online && session?.sftp ? 'copy' : 'none'
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if ((e.target as HTMLElement).closest('.os-window')) return
          if (!session || !online || !session.sftp || !e.dataTransfer.files.length) return
          setDrop({
            sessionId: session.id,
            name: session.profile.displayName || session.profile.host,
            path: `${session.home === '/' ? '' : session.home}/Uploads`,
            files: [...e.dataTransfer.files],
          })
        }}
      >
        <nav className="desktop-shortcuts" aria-label="Desktop shortcuts">
          {(['files', 'terminal', 'server'] as const).map((id) => {
            const app = apps[id]
            return (
              <button
                key={id}
                disabled={!session}
                aria-label={`Open ${app.name}`}
                onDoubleClick={() => open(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    open(id)
                  }
                }}
              >
                <span className={`desktop-app-icon ${app.color}`}>
                  <app.icon size={31} strokeWidth={1.7} />
                </span>
                <span>{app.name}</span>
              </button>
            )
          })}
        </nav>
        <div className="desktop-greeting">
          <span className="desktop-eyebrow">A LITTLE SPACE TO GET THINGS DONE</span>
          <h1>
            Your server.
            <br />
            <span>Your workspace.</span>
          </h1>
          <p>Files, a terminal, and everything in its place.</p>
        </div>
        {session && (
          <div className="desktop-server-card">
            <span className={`desktop-status-dot ${online ? 'online' : ''}`} />
            <div>
              <strong>
                {session.profile.displayName || session.hostname || session.profile.host}
              </strong>
              <span>
                {session.profile.username}@{session.profile.host}
              </span>
            </div>
            <span className="desktop-connection-label">{online ? 'SSH connected' : 'Offline'}</span>
          </div>
        )}
        {(warning || session?.warning) && (
          <div className="desktop-warning" role="status">
            {warning || session?.warning}
          </div>
        )}
        {windows.map((w) => {
          const s = sessions.find((s) => s.id === w.sessionId)
          const visible =
            (!w.sessionId || w.sessionId === activeId) && !!session && w.mode !== 'minimized'
          return (
            <WindowFrame
              key={w.id}
              window={w}
              area={area}
              visible={visible}
              focused={visible && activeWindow === w.id}
              index={w.order}
              serverName={s?.profile.displayName || s?.profile.host}
              onClose={() => closeWindow(w)}
            >
              <Suspense fallback={<Loading label="Opening app…" />}>
                <WindowApp
                  w={w}
                  session={s}
                  visible={visible}
                  focused={visible && activeWindow === w.id}
                  request={w.sessionId ? requests[w.sessionId] : undefined}
                  openTerminal={openTerminal}
                  navigate={navigate}
                />
              </Suspense>
            </WindowFrame>
          )
        })}
        {dragging && (
          <div className="desktop-drop-overlay" aria-live="polite">
            <Upload size={42} />
            <h2>
              {online && session?.sftp
                ? 'Upload to your server'
                : 'Connect a server with SFTP to upload'}
            </h2>
            <p>
              {online && session?.sftp
                ? 'Choose the destination folder when you drop.'
                : 'Your files stay on this computer.'}
            </p>
            <strong>{session?.profile.displayName || session?.profile.host}</strong>
          </div>
        )}
      </main>
      <footer className="os-taskbar">
        <div className="taskbar-left">
          <ShieldCheck size={16} />
          <span>{session ? 'SSH / SFTP' : 'Local workspace'}</span>
        </div>
        <nav className="taskbar-apps" aria-label="Taskbar">
          <button
            className={`taskbar-button launcher-button ${launcher ? 'is-active' : ''}`}
            aria-label="Open launcher"
            title="Launcher (Ctrl+K)"
            onClick={() => {
              setSearch('')
              setLauncher(true)
            }}
          >
            <Grid2X2 size={23} />
          </button>
          <span className="taskbar-divider" />
          {taskApps.map((id) => {
            const app = apps[id],
              w = opened.find((w) => w.app === id)
            return (
              <button
                key={id}
                className={`taskbar-button ${w ? 'is-running' : ''} ${w && w.id === activeWindow && w.mode !== 'minimized' ? 'is-active' : ''}`}
                aria-label={app.name}
                title={app.name}
                disabled={!session && id !== 'settings'}
                onClick={() =>
                  w && w.id === activeWindow && w.mode !== 'minimized'
                    ? useDesktop.getState().minimize(w.id)
                    : open(id)
                }
              >
                <span className={`taskbar-app-icon ${app.color}`}>
                  <app.icon size={23} strokeWidth={1.8} />
                </span>
              </button>
            )
          })}
          {opened
            .filter((w) => w.app === 'editor')
            .map((w) => (
              <button
                key={w.id}
                className={`taskbar-button is-running ${w.id === activeWindow && w.mode !== 'minimized' ? 'is-active' : ''}`}
                aria-label={`Editor ${w.path}`}
                title={`${w.dirty ? 'Unsaved · ' : ''}${w.path}`}
                onClick={() => useDesktop.getState().focus(w.id)}
              >
                <FileCode2 size={22} />
                {w.dirty && <span className="taskbar-dirty" />}
              </button>
            ))}
        </nav>
        <div className="taskbar-tray">
          <button
            aria-label="Transfer activity"
            className="tray-transfer"
            title={`${activeTransfers} active transfers`}
            disabled={!session}
            onClick={() => open('transfers')}
          >
            <ArrowDownUp size={16} />
            {activeTransfers > 0 && <span>{activeTransfers}</span>}
          </button>
          <Menu.Root>
            <Menu.Trigger className="tray-server" aria-label="Server connections">
              <span className={`desktop-status-dot ${online ? 'online' : ''}`} />
              <span>{session?.profile.displayName || session?.profile.host || 'Servers'}</span>
              <ChevronDown size={13} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="context-menu server-menu"
                side="top"
                align="end"
                sideOffset={12}
              >
                <Menu.Label className="menu-label">YOUR SERVERS</Menu.Label>
                {sessions
                  .filter((s) => ['CONNECTED', 'CONNECTION_LOST', 'DISCONNECTED'].includes(s.state))
                  .map((s) => (
                    <Menu.Item
                      key={s.id}
                      onSelect={() => useApp.getState().set({ activeId: s.id })}
                    >
                      <Server size={15} />
                      <span>{s.profile.displayName || s.profile.host}</span>
                      <small>
                        {s.id === activeId
                          ? 'Current'
                          : s.state === 'CONNECTED'
                            ? 'Connected'
                            : 'Offline'}
                      </small>
                    </Menu.Item>
                  ))}
                <Menu.Separator />
                <Menu.Item onSelect={onConnect}>
                  <Plus size={15} /> Add connection
                </Menu.Item>
                <Menu.Item disabled={!online} onSelect={onDisconnect}>
                  <LogOut size={15} /> Disconnect
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <time className="taskbar-clock" dateTime={clock.toISOString()}>
            <span>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{clock.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          </time>
          <button
            className="show-desktop"
            aria-label="Show desktop"
            title="Show desktop (Ctrl+Alt+D)"
            onClick={() =>
              opened
                .filter((w) => w.mode !== 'minimized')
                .forEach((w) => useDesktop.getState().minimize(w.id))
            }
          />
        </div>
      </footer>
      <Dialog.Root open={launcher} onOpenChange={setLauncher}>
        <Dialog.Portal>
          <Dialog.Overlay className="launcher-overlay" />
          <Dialog.Content className="os-launcher" aria-describedby="launcher-description">
            <div className="launcher-search">
              <Search size={18} />
              <input
                aria-label="Search apps"
                placeholder="Find an app…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </div>
            <div className="launcher-heading">
              <Dialog.Title>Your workspace</Dialog.Title>
              <Dialog.Close asChild>
                <IconButton title="Close launcher">
                  <X size={17} />
                </IconButton>
              </Dialog.Close>
            </div>
            <Dialog.Description id="launcher-description">
              A few good tools. Everything you need.
            </Dialog.Description>
            <div className="launcher-grid">
              {(Object.keys(apps) as AppId[])
                .filter((id) =>
                  `${apps[id].name} ${apps[id].description}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((id) => {
                  const app = apps[id]
                  return (
                    <div className="launcher-app" key={id}>
                      <button disabled={!session && id !== 'settings'} onClick={() => open(id)}>
                        <span className={`desktop-app-icon ${app.color}`}>
                          <app.icon size={26} strokeWidth={1.7} />
                        </span>
                        <strong>{app.name}</strong>
                        <small>{app.description}</small>
                      </button>
                      <button
                        className={`pin-app ${layout.pinned.includes(id) ? 'pinned' : ''}`}
                        aria-label={`${layout.pinned.includes(id) ? 'Unpin' : 'Pin'} ${app.name}`}
                        onClick={() => useDesktop.getState().pin(id)}
                      >
                        <Pin size={12} />
                      </button>
                    </div>
                  )
                })}
            </div>
            {!(Object.keys(apps) as AppId[]).some((id) =>
              `${apps[id].name} ${apps[id].description}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p className="launcher-empty">No apps found. Try another name.</p>}
            <div className="launcher-footer">
              <span>
                <Monitor size={16} /> VPS Manager
              </span>
              <button
                onClick={() => {
                  setLauncher(false)
                  onConnect()
                }}
              >
                <Plus size={15} /> Connect a server
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {drop && (
        <Modal
          title="Upload to server"
          description={`${drop.files.length} selected item${drop.files.length === 1 ? '' : 's'} · ${drop.name}`}
          onClose={() => {
            if (!uploading) setDrop(undefined)
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void uploadDrop()
            }}
          >
            <div className="upload-selection">
              <Folder size={26} />
              <span>
                {drop.files
                  .slice(0, 3)
                  .map((f) => f.name)
                  .join(', ')}
                {drop.files.length > 3 ? ` and ${drop.files.length - 3} more` : ''}
              </span>
            </div>
            <label>
              Destination folder
              <input
                required
                aria-label="Upload destination"
                value={drop.path}
                onChange={(e) => setDrop({ ...drop, path: e.target.value })}
                disabled={uploading}
                pattern="/.*"
              />
            </label>
            <p className="muted">
              Uploads in your home folder is created if needed. Other destination folders must
              already exist. Existing files are reviewed before replacement.
            </p>
            <div className="dialog-actions">
              <button type="button" disabled={uploading} onClick={() => setDrop(undefined)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  uploading || sessions.find((s) => s.id === drop.sessionId)?.state !== 'CONNECTED'
                }
              >
                <Upload size={15} />
                {uploading ? 'Preparing upload…' : `Upload to ${drop.name}`}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
