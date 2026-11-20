import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import * as Menu from '@radix-ui/react-dropdown-menu'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Grid2X2,
  Home,
  Info,
  Link,
  List,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ServerSession } from '../../../../domain/connection/types'
import type { RemoteFile } from '../../../../domain/filesystem/types'
import { rpc, errorText } from '../../app/api'
import { useAction } from '../../hooks/use-action'
import { useApp } from '../../app/store'
import {
  bytes,
  Empty,
  ErrorMessage,
  formatDate,
  IconButton,
  Loading,
  Modal,
  PageHeading,
} from '../../components/ui'

function parent(path: string) {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
function join(path: string, name: string) {
  return `${path === '/' ? '' : path}/${name}`
}
type Form = {
  kind: 'file' | 'directory' | 'rename' | 'move'
  title: string
  value: string
  path?: string
}
export function Explorer({
  session,
  active,
  openTerminal,
  openEditor,
  request,
}: {
  session: ServerSession
  active: boolean
  openTerminal: (cwd: string) => void
  openEditor: (path: string) => void
  request?: { id: string; cwd: string }
}) {
  const sessionId = session.id
  const client = useQueryClient()
  const [history, setHistory] = useState([session.profile.lastDirectory || session.home])
  const [index, setIndex] = useState(0)
  const path = history[index]
  const [address, setAddress] = useState(path)
  const addressRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState(0)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'name' | 'size' | 'mtime' | 'type'>('name')
  const [descending, setDescending] = useState(false)
  const [grid, setGrid] = useState(false)
  const [form, setForm] = useState<Form>()
  const [properties, setProperties] = useState<RemoteFile>()
  const [mode, setMode] = useState('644')
  const [clipboard, setClipboard] = useState<{ paths: string[]; cut: boolean }>()
  const [context, setContext] = useState<{ x: number; y: number }>()
  const [dragging, setDragging] = useState(false)
  const [cancellable, setCancellable] = useState(false)
  const hidden = useApp((s) => s.preferences.hiddenFiles)
  const { busy, run } = useAction()
  const scroll = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(5)
  useEffect(() => {
    if (request) {
      setHistory([request.cwd])
      setIndex(0)
      setAddress(request.cwd)
      setSelected([])
      setAnchor(0)
      setFilter('')
      setContext(undefined)
      setForm(undefined)
      setProperties(undefined)
    }
  }, [request])
  useEffect(() => {
    if (!scroll.current || !active) return
    const observer = new ResizeObserver(([entry]) =>
      setColumns(Math.max(2, Math.floor(entry.contentRect.width / 140))),
    )
    observer.observe(scroll.current)
    return () => observer.disconnect()
  }, [active, grid])
  const query = useQuery({
    queryKey: ['directory', sessionId, path],
    queryFn: () => rpc('files.list', { sessionId, path }),
    enabled: active && session.state === 'CONNECTED' && session.sftp,
  })
  const entries = useMemo(
    () =>
      (query.data?.entries || [])
        .filter(
          (f) =>
            (hidden || !f.name.startsWith('.')) &&
            f.name.toLowerCase().includes(filter.toLowerCase()),
        )
        .sort((a, b) => {
          if ((a.type === 'directory') !== (b.type === 'directory'))
            return a.type === 'directory' ? -1 : 1
          const result =
            sort === 'name' || sort === 'type'
              ? a[sort].localeCompare(b[sort], undefined, { numeric: true })
              : a[sort] - b[sort]
          return descending ? -result : result
        }),
    [query.data, hidden, filter, sort, descending],
  )
  const virtual = useVirtualizer({
    count: grid ? Math.ceil(entries.length / columns) : entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => (grid ? 100 : 40),
    overscan: 12,
  })
  useEffect(() => {
    const stop = window.vps.onEvent((event) => {
      if (
        event.type === 'transfer' &&
        event.job.sessionId === sessionId &&
        event.job.status === 'COMPLETED'
      )
        void client.invalidateQueries({ queryKey: ['directory', sessionId] })
    })
    return stop
  }, [client, sessionId])
  const navigate = (next: string) => {
    if (next === path) return
    setHistory((h) => [...h.slice(0, index + 1), next])
    setIndex(index + 1)
    setAddress(next)
    setSelected([])
    setFilter('')
  }
  const travel = (next: number) => {
    if (next < 0 || next >= history.length) return
    setIndex(next)
    setAddress(history[next])
    setSelected([])
  }
  const refresh = () => client.invalidateQueries({ queryKey: ['directory', sessionId] })
  const mutate = (action: () => Promise<unknown>, cancel = false) => {
    setCancellable(cancel)
    void run(async () => {
      try {
        await action()
        setSelected([])
      } finally {
        await refresh()
      }
    }).finally(() => setCancellable(false))
  }
  const open = (entry: RemoteFile) => {
    if (entry.type === 'directory' || entry.type === 'symlink') {
      if (entry.type === 'symlink')
        void run(async () => {
          const stat = await rpc('files.resolve', { sessionId, path: entry.path })
          if (stat.type === 'directory') navigate(stat.path)
          else if (stat.type === 'file') openEditor(stat.path)
          else
            useApp
              .getState()
              .set({ error: 'This link target cannot be opened in the file explorer.' })
        })
      else navigate(entry.path)
    } else if (entry.type === 'file') openEditor(entry.path)
  }
  const select = (
    entry: RemoteFile,
    i: number,
    event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  ) => {
    if (event.shiftKey)
      setSelected(entries.slice(Math.min(anchor, i), Math.max(anchor, i) + 1).map((f) => f.path))
    else if (event.ctrlKey || event.metaKey) {
      setSelected((s) =>
        s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path],
      )
      setAnchor(i)
    } else {
      setSelected([entry.path])
      setAnchor(i)
    }
  }
  const upload = (folders: boolean) =>
    mutate(() => rpc('transfers.upload', { sessionId, path, folders, conflict: 'ask' }))
  const download = () => {
    if (selected.length)
      mutate(() => rpc('transfers.download', { sessionId, paths: selected, conflict: 'ask' }))
  }
  const remove = () => {
    if (selected.length) mutate(() => rpc('files.delete', { sessionId, paths: selected }), true)
  }
  const rename = () => {
    if (selected.length === 1)
      setForm({
        kind: 'rename',
        title: 'Rename entry',
        value: selected[0].split('/').at(-1)!,
        path: selected[0],
      })
  }
  const paste = () => {
    if (!clipboard) return
    mutate(async () => {
      if (clipboard.cut) {
        for (const source of clipboard.paths)
          await rpc('files.rename', {
            sessionId,
            path: source,
            destination: join(path, source.split('/').at(-1)!),
          })
        setClipboard(undefined)
      } else await rpc('files.copy', { sessionId, paths: clipboard.paths, destination: path })
    }, !clipboard.cut)
  }
  const showProperties = () => {
    if (selected.length === 1)
      void run(async () => {
        const f = await rpc('files.stat', { sessionId, path: selected[0] })
        setProperties(f)
        setMode((f.mode & 0o777).toString(8).padStart(3, '0'))
      })
  }
  const keyboard = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,[contenteditable="true"],.cm-editor'))
      return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (ctrl && key === 'a') {
      e.preventDefault()
      setSelected(entries.map((f) => f.path))
    } else if (ctrl && key === 'c') {
      e.preventDefault()
      setClipboard({ paths: selected, cut: false })
    } else if (ctrl && key === 'x') {
      e.preventDefault()
      setClipboard({ paths: selected, cut: true })
    } else if (ctrl && key === 'v') {
      e.preventDefault()
      paste()
    } else if (ctrl && key === 'l') {
      e.preventDefault()
      addressRef.current?.focus()
      addressRef.current?.select()
    } else if (ctrl && e.shiftKey && key === 'n') {
      e.preventDefault()
      setForm({ kind: 'directory', title: 'New folder', value: '' })
    } else if (e.altKey && key === 'arrowleft') {
      e.preventDefault()
      travel(index - 1)
    } else if (e.altKey && key === 'arrowright') {
      e.preventDefault()
      travel(index + 1)
    } else if (e.altKey && key === 'arrowup') {
      e.preventDefault()
      navigate(parent(path))
    } else if (key === 'f5') {
      e.preventDefault()
      void refresh()
    } else if (key === 'f2') {
      e.preventDefault()
      rename()
    } else if (key === 'delete') {
      e.preventDefault()
      remove()
    } else if (key === 'enter' && selected.length === 1) {
      e.preventDefault()
      const f = entries.find((f) => f.path === selected[0])
      if (f) open(f)
    } else if (key === 'arrowdown' || key === 'arrowup') {
      e.preventDefault()
      const current = entries.findIndex((f) => f.path === selected.at(-1))
      const next = Math.min(
        entries.length - 1,
        Math.max(0, current + (key === 'arrowdown' ? 1 : -1)),
      )
      if (entries[next]) {
        select(entries[next], next, e)
        virtual.scrollToIndex(grid ? Math.floor(next / columns) : next)
      }
    } else if (key === 'f10' && e.shiftKey) {
      e.preventDefault()
      setContext({ x: 420, y: 260 })
    }
  }
  const sorted = (value: typeof sort) => {
    if (sort === value) setDescending(!descending)
    else {
      setSort(value)
      setDescending(false)
    }
  }
  return (
    <div
      className="explorer-page"
      hidden={!active}
      onKeyDown={keyboard}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = session.state === 'CONNECTED' && session.sftp ? 'copy' : 'none'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragging(false)
        if (session.state !== 'CONNECTED' || !session.sftp) return
        const dropped = [...e.dataTransfer.files]
        const destination = { sessionId, path }
        if (dropped.length)
          mutate(async () => {
            const tokens = await window.vps.droppedFiles(dropped)
            await rpc('transfers.drop', { ...destination, tokens, conflict: 'ask' })
          })
      }}
    >
      <PageHeading title="Files" description="Explore and manage your remote filesystem.">
        <span className="badge">SFTP</span>
        <button className="primary" disabled={busy || !session.sftp} onClick={() => upload(false)}>
          <Upload size={16} />
          Upload files
        </button>
      </PageHeading>
      {!session.sftp ? (
        <ErrorMessage error="SFTP is unavailable. Reconnect after enabling the server’s SFTP subsystem. Terminal remains available." />
      ) : (
        <div className="explorer-panel panel">
          <div className="address-toolbar">
            <IconButton
              title="Back (Alt+Left)"
              disabled={index === 0}
              onClick={() => travel(index - 1)}
            >
              <ArrowLeft size={17} />
            </IconButton>
            <IconButton
              title="Forward (Alt+Right)"
              disabled={index === history.length - 1}
              onClick={() => travel(index + 1)}
            >
              <ArrowRight size={17} />
            </IconButton>
            <IconButton
              title="Parent directory (Alt+Up)"
              disabled={path === '/'}
              onClick={() => navigate(parent(path))}
            >
              <ArrowUp size={17} />
            </IconButton>
            <IconButton title="Home directory" onClick={() => navigate(session.home)}>
              <Home size={17} />
            </IconButton>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (address.startsWith('/')) navigate(address)
                else
                  useApp
                    .getState()
                    .set({ error: 'Enter an absolute remote path beginning with /.' })
              }}
              className="address-field"
            >
              <Folder size={16} />
              <input
                ref={addressRef}
                aria-label="Remote path"
                spellCheck={false}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </form>
            <IconButton
              title="Refresh (F5)"
              disabled={query.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} className={query.isFetching ? 'spin' : ''} />
            </IconButton>
          </div>
          <nav className="breadcrumbs" aria-label="Remote directory breadcrumbs">
            <button onClick={() => navigate('/')}>root</button>
            {path
              .split('/')
              .filter(Boolean)
              .map((part, i, parts) => (
                <span key={i}>
                  /{' '}
                  <button onClick={() => navigate('/' + parts.slice(0, i + 1).join('/'))}>
                    {part}
                  </button>
                </span>
              ))}
          </nav>
          <div className="file-toolbar">
            <button disabled={busy} onClick={() => upload(true)}>
              <Upload size={15} />
              Upload folder
            </button>
            <button
              disabled={busy}
              onClick={() => setForm({ kind: 'directory', title: 'New folder', value: '' })}
            >
              <FolderPlus size={16} />
              New folder
            </button>
            <button
              disabled={busy}
              onClick={() => setForm({ kind: 'file', title: 'New text file', value: '' })}
            >
              <FilePlus size={16} />
              New file
            </button>
            <span className="separator" />
            <IconButton
              title="Download selected"
              disabled={busy || !selected.length}
              onClick={download}
            >
              <ArrowDownToLine size={16} />
            </IconButton>
            <IconButton
              title="Copy (Ctrl+C)"
              disabled={!selected.length}
              onClick={() => setClipboard({ paths: selected, cut: false })}
            >
              <Copy size={16} />
            </IconButton>
            <IconButton
              title="Cut (Ctrl+X)"
              disabled={!selected.length}
              onClick={() => setClipboard({ paths: selected, cut: true })}
            >
              <Scissors size={16} />
            </IconButton>
            <IconButton
              title="Paste (Ctrl+V)"
              disabled={busy || !clipboard?.paths.length}
              onClick={paste}
            >
              <ClipboardPaste size={16} />
            </IconButton>
            <IconButton
              title="Rename (F2)"
              disabled={busy || selected.length !== 1}
              onClick={rename}
            >
              <Pencil size={16} />
            </IconButton>
            <IconButton
              title="Delete permanently"
              disabled={busy || !selected.length}
              onClick={remove}
            >
              <Trash2 size={16} />
            </IconButton>
            <div className="toolbar-spacer" />
            <IconButton
              title={hidden ? 'Hide dotfiles' : 'Show hidden files'}
              onClick={() => {
                const preferences = { ...useApp.getState().preferences, hiddenFiles: !hidden }
                useApp.getState().set({ preferences })
                void run(() => rpc('app.preferences', preferences))
              }}
            >
              {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
            </IconButton>
            <IconButton
              title={grid ? 'List view' : 'Grid view'}
              onClick={() => {
                setGrid(!grid)
                virtual.measure()
              }}
            >
              {grid ? <List size={17} /> : <Grid2X2 size={17} />}
            </IconButton>
            <Menu.Root>
              <Menu.Trigger asChild>
                <button className="icon-button" aria-label="More file actions">
                  <MoreHorizontal size={18} />
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="context-menu" align="end">
                  <Menu.Item onSelect={showProperties} disabled={selected.length !== 1}>
                    <Info size={15} />
                    Properties & permissions
                  </Menu.Item>
                  <Menu.Item onSelect={() => openTerminal(path)}>
                    <Terminal size={15} />
                    Open terminal here
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
          <div className="directory-filter">
            {cancellable && busy && (
              <button
                onClick={() => {
                  void rpc('files.cancel', { sessionId })
                }}
              >
                Cancel file operation
              </button>
            )}
            <div className="search-field">
              <Search size={15} />
              <input
                placeholder="Filter this folder…"
                aria-label="Filter this folder"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <span>
              {selected.length ? `${selected.length} selected` : `${entries.length} items`}
            </span>
            {clipboard && (
              <span className="badge">
                {clipboard.paths.length} {clipboard.cut ? 'cut' : 'copied'}
              </span>
            )}
          </div>
          {query.error ? (
            <ErrorMessage error={errorText(query.error)} />
          ) : query.isPending ? (
            <Loading label="Reading remote directory…" />
          ) : (
            <>
              <div className="file-table-heading file-columns">
                <span>
                  <input
                    type="checkbox"
                    aria-label="Select all files"
                    checked={entries.length > 0 && entries.every((f) => selected.includes(f.path))}
                    onChange={(e) =>
                      setSelected(e.target.checked ? entries.map((f) => f.path) : [])
                    }
                  />
                  <button onClick={() => sorted('name')}>
                    Name {sort === 'name' && (descending ? '↓' : '↑')}
                  </button>
                </span>
                <button onClick={() => sorted('size')}>Size</button>
                <button onClick={() => sorted('mtime')}>Modified</button>
                <button onClick={() => sorted('type')}>Type</button>
                <span>Permissions</span>
                <span>Owner</span>
              </div>
              <div
                ref={scroll}
                className="file-scroll"
                role="grid"
                aria-label="Remote files"
                aria-multiselectable="true"
                aria-rowcount={entries.length}
                tabIndex={0}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  // Keep a row under the pointer when a compact window has an outer scroller.
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                }}
              >
                {!entries.length ? (
                  <Empty title={filter ? 'No matching files' : 'This folder is empty'}>
                    {filter
                      ? 'Try a different filter.'
                      : 'Upload files or create a folder to get started.'}
                  </Empty>
                ) : (
                  <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                    {virtual.getVirtualItems().map((row) => (
                      <div
                        key={row.key}
                        className={grid ? 'file-grid-row' : ''}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: row.size,
                          transform: `translateY(${row.start}px)`,
                          ...(grid
                            ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                            : {}),
                        }}
                      >
                        {(grid
                          ? entries.slice(row.index * columns, row.index * columns + columns)
                          : [entries[row.index]]
                        ).map((f, offset) => (
                          <div
                            key={f.path}
                            role="row"
                            aria-selected={selected.includes(f.path)}
                            className={`${grid ? 'grid-file' : 'file-row file-columns'} ${selected.includes(f.path) ? 'selected' : ''} ${clipboard?.cut && clipboard.paths.includes(f.path) ? 'cut' : ''}`}
                            onClick={(e) =>
                              select(f, grid ? row.index * columns + offset : row.index, e)
                            }
                            onDoubleClick={() => open(f)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              if (!selected.includes(f.path)) setSelected([f.path])
                              setContext({ x: e.clientX, y: e.clientY })
                            }}
                          >
                            <span className="file-name" role="gridcell">
                              <input
                                tabIndex={-1}
                                type="checkbox"
                                aria-label={`Select ${f.name}`}
                                checked={selected.includes(f.path)}
                                readOnly
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setSelected((s) =>
                                    s.includes(f.path)
                                      ? s.filter((p) => p !== f.path)
                                      : [...s, f.path],
                                  )
                                }}
                              />
                              {f.type === 'directory' ? (
                                <Folder
                                  size={grid ? 32 : 19}
                                  className="folder-icon"
                                  fill="currentColor"
                                />
                              ) : f.type === 'symlink' ? (
                                <Link size={19} />
                              ) : (
                                <File size={grid ? 28 : 18} className="file-icon" />
                              )}
                              <span title={f.name}>{f.name}</span>
                            </span>
                            {!grid && (
                              <>
                                <span role="gridcell">
                                  {f.type === 'directory' ? '—' : bytes(f.size)}
                                </span>
                                <span role="gridcell">{formatDate(f.mtime)}</span>
                                <span role="gridcell">{f.type}</span>
                                <code role="gridcell">
                                  {(f.mode & 0o7777).toString(8).padStart(3, '0')}
                                </code>
                                <span role="gridcell">
                                  {f.uid}:{f.gid}
                                </span>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="explorer-footer">
            <span>{query.data?.path || path}</span>
            <span>
              {entries.filter((f) => f.type === 'file').reduce((s, f) => s + f.size, 0) > 0
                ? `${bytes(entries.reduce((s, f) => s + (f.type === 'file' ? f.size : 0), 0))} in files`
                : ''}
            </span>
            <span>{busy ? 'Operation in progress…' : 'Your account’s permissions apply'}</span>
          </div>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={38} />
          <h2>Upload to {session.profile.displayName || session.profile.host}</h2>
          <code>{path}</code>
          <p>Conflicts will be reviewed before replacement.</p>
        </div>
      )}
      <Menu.Root
        open={!!context}
        onOpenChange={(open) => {
          if (!open) setContext(undefined)
        }}
      >
        <Menu.Trigger
          style={{
            position: 'fixed',
            left: context?.x ?? 0,
            top: context?.y ?? 0,
            width: 0,
            height: 0,
            padding: 0,
            border: 0,
          }}
          aria-label="File context menu"
        />
        <Menu.Portal>
          <Menu.Content className="context-menu" align="start">
            <Menu.Item
              disabled={selected.length !== 1}
              onSelect={() => {
                const f = entries.find((f) => f.path === selected[0])
                if (f) open(f)
              }}
            >
              Open
            </Menu.Item>
            <Menu.Item disabled={!selected.length} onSelect={download}>
              Download
            </Menu.Item>
            <Menu.Item disabled={selected.length !== 1} onSelect={rename}>
              Rename
            </Menu.Item>
            <Menu.Item onSelect={() => setClipboard({ paths: selected, cut: false })}>
              Copy
            </Menu.Item>
            <Menu.Item onSelect={() => setClipboard({ paths: selected, cut: true })}>Cut</Menu.Item>
            <Menu.Item disabled={!clipboard?.paths.length} onSelect={paste}>
              Paste
            </Menu.Item>
            <Menu.Item
              disabled={selected.length !== 1}
              onSelect={() =>
                setForm({
                  kind: 'move',
                  title: 'Move to directory',
                  value: path,
                  path: selected[0],
                })
              }
            >
              Move to…
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item disabled={selected.length !== 1} onSelect={showProperties}>
              Properties & permissions
            </Menu.Item>
            <Menu.Item
              onSelect={() => {
                void run(() => rpc('clipboard.writeText', { text: selected.join('\n') }))
              }}
            >
              Copy full path
            </Menu.Item>
            <Menu.Item onSelect={() => navigate(parent(selected[0] || path))}>
              Open parent directory
            </Menu.Item>
            <Menu.Item
              onSelect={() => {
                const f = entries.find((f) => f.path === selected[0])
                openTerminal(f?.type === 'directory' ? f.path : path)
              }}
            >
              Open terminal here
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item className="danger-text" disabled={!selected.length} onSelect={remove}>
              Delete permanently…
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {form && (
        <Modal
          title={form.title}
          description={
            form.kind === 'move'
              ? 'Enter the absolute destination directory. Existing entries will never be overwritten.'
              : 'Enter a name for this remote entry.'
          }
          onClose={() => setForm(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = form
              mutate(async () => {
                if (f.kind === 'rename' || f.kind === 'move')
                  await rpc('files.rename', {
                    sessionId,
                    path: f.path!,
                    destination:
                      f.kind === 'move'
                        ? join(f.value, f.path!.split('/').at(-1)!)
                        : join(parent(f.path!), f.value),
                  })
                else await rpc('files.create', { sessionId, path, name: f.value, kind: f.kind })
                setForm(undefined)
              })
            }}
          >
            <label>
              {form.kind === 'move' ? 'Destination directory' : 'Name'}
              <input
                autoFocus
                required
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setForm(undefined)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Apply
              </button>
            </div>
          </form>
        </Modal>
      )}
      {properties && (
        <Modal
          title="Properties & permissions"
          description={properties.path}
          onClose={() => setProperties(undefined)}
        >
          <dl className="info-list">
            {Object.entries({
              Type: properties.type,
              Size: bytes(properties.size),
              Modified: formatDate(properties.mtime),
              'Owner / group': `${properties.uid} / ${properties.gid}`,
              Mode: (properties.mode & 0o7777).toString(8),
            }).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {properties.type !== 'symlink' && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                mutate(async () => {
                  await rpc('files.chmod', { sessionId, path: properties.path, mode })
                  setProperties(undefined)
                })
              }}
            >
              <label>
                Unix permissions (octal)
                <input
                  required
                  pattern="[0-7]{3}"
                  maxLength={3}
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                />
              </label>
              <div className="dialog-actions">
                <button className="primary" disabled={busy}>
                  Change permissions…
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  )
}
