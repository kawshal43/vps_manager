import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Plus, Search, Terminal as TerminalIcon, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { rpc } from '../../app/api'
import { Empty, IconButton, PageHeading } from '../../components/ui'
import type { ServerSession } from '../../../../domain/connection/types'
import { attachTerminalClipboard } from './clipboard'

function TerminalPane({
  sessionId,
  cwd,
  active,
  focused,
}: {
  sessionId: string
  cwd?: string
  active: boolean
  focused: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const searchRef = useRef<SearchAddon | undefined>(undefined)
  const termRef = useRef<XTerm | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [interactionError, setInteractionError] = useState('')
  const [status, setStatus] = useState('Opening SSH shell…')
  const focusRef = useRef(focused)
  useEffect(() => {
    focusRef.current = focused
  }, [focused])
  useEffect(() => {
    if (!container.current) return
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: false,
      theme: {
        background: '#101725',
        foreground: '#dbe3ee',
        cursor: '#86aafa',
        selectionBackground: '#344b70',
      },
    })
    const fit = new FitAddon()
    const finder = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(finder)
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        void rpc('shell.openExternal', { url }).catch(() => {})
      }),
    )
    term.open(container.current)
    const clipboard = attachTerminalClipboard(term, container.current, setInteractionError)
    fit.fit()
    fitRef.current = fit
    searchRef.current = finder
    termRef.current = term
    let id: string | undefined
    let disposed = false
    const off = window.vps.onEvent((e) => {
      if (e.type === 'terminal-data' && e.id === id)
        term.write(e.data, () => {
          if (id && !disposed) void rpc('terminal.ack', { id, bytes: e.bytes }).catch(() => {})
        })
      if (e.type === 'terminal-exit' && e.id === id) {
        setStatus('Shell closed')
        term.write('\r\n\x1b[90m[SSH shell closed]\x1b[0m\r\n')
      }
    })
    let pendingInput = Promise.resolve()
    const input = term.onData((data) => {
      const terminalId = id
      if (!terminalId || disposed) return
      pendingInput = pendingInput
        .then(async () => {
          // A paste may exceed one IPC request. Keep chunks and later keystrokes ordered.
          for (let start = 0; start < data.length;) {
            if (disposed) return
            let end = Math.min(start + 65536, data.length)
            const last = data.charCodeAt(end - 1)
            if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
            await rpc('terminal.input', { id: terminalId, data: data.slice(start, end) })
            start = end
          }
        })
        .catch(() => {
          if (!disposed)
            setInteractionError('Terminal input could not be sent. Check the shell connection.')
        })
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (id) void rpc('terminal.resize', { id, cols, rows }).catch(() => {})
    })
    void rpc('terminal.open', { sessionId, cwd, cols: term.cols, rows: term.rows }).then(
      (remoteId) => {
        if (disposed) {
          void rpc('terminal.close', { id: remoteId })
          return
        }
        id = remoteId
        setStatus('Interactive SSH shell')
        void rpc('terminal.ack', { id, bytes: 0 })
        if (focusRef.current) term.focus()
      },
      (e) => {
        setStatus(e instanceof Error ? e.message : 'Shell unavailable')
      },
    )
    const observer = new ResizeObserver(() => {
      if (container.current?.offsetWidth) fit.fit()
    })
    observer.observe(container.current)
    return () => {
      disposed = true
      off()
      observer.disconnect()
      input.dispose()
      resize.dispose()
      clipboard.dispose()
      if (id) void rpc('terminal.close', { id }).catch(() => {})
      term.dispose()
      fitRef.current = undefined
      searchRef.current = undefined
      termRef.current = undefined
    }
  }, [sessionId, cwd])
  useEffect(() => {
    if (active) {
      fitRef.current?.fit()
      if (focused) termRef.current?.focus()
    }
  }, [active, focused])
  return (
    <div className="terminal-pane" hidden={!active}>
      <form
        className="terminal-search"
        onSubmit={(e) => {
          e.preventDefault()
          searchRef.current?.findNext(search)
        }}
      >
        <span>
          <span className="status-dot" />
          {status}
        </span>
        <Search size={14} />
        <input
          aria-label="Search terminal"
          placeholder="Find in terminal…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button disabled={!search}>Find</button>
      </form>
      {interactionError && (
        <div className="terminal-interaction-error" role="alert">
          {interactionError}
        </div>
      )}
      <div
        className="terminal-canvas"
        ref={container}
        title="Select text and right-click to copy. Right-click without a selection to paste."
      />
    </div>
  )
}
export function Terminals({
  session,
  active,
  request,
  focused = active,
}: {
  session: ServerSession
  active: boolean
  focused?: boolean
  request?: { id: string; cwd: string }
}) {
  const [tabs, setTabs] = useState<{ id: string; cwd?: string }[]>([])
  const [selected, setSelected] = useState<string>()
  const initialized = useRef(false)
  const requestId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (active && !initialized.current && !request) {
      initialized.current = true
      const id = crypto.randomUUID()
      setTabs([{ id }])
      setSelected(id)
    }
  }, [active, request])
  useEffect(() => {
    if (request && request.id !== requestId.current) {
      requestId.current = request.id
      initialized.current = true
      setTabs((t) => [...t, request])
      setSelected(request.id)
    }
  }, [request])
  const add = () => {
    const id = crypto.randomUUID()
    setTabs((t) => [...t, { id }])
    setSelected(id)
  }
  return (
    <div className="terminal-page" hidden={!active}>
      <PageHeading
        title="Terminal"
        description={`${session.profile.username}@${session.profile.host} · Commands run with your account’s permissions.`}
      >
        <button disabled={tabs.length >= 16} onClick={add}>
          <Plus size={16} />
          New terminal
        </button>
      </PageHeading>
      <div className="terminal-workspace">
        <div className="terminal-tabs" role="tablist">
          {tabs.map((tab, i) => (
            <div key={tab.id} className={selected === tab.id ? 'active' : ''}>
              <button
                role="tab"
                aria-selected={selected === tab.id}
                onClick={() => setSelected(tab.id)}
              >
                <TerminalIcon size={14} /> {tab.cwd?.split('/').at(-1) || `Shell ${i + 1}`}
              </button>
              <IconButton
                title="Close terminal"
                onClick={() => {
                  setTabs((t) => t.filter((v) => v.id !== tab.id))
                  if (selected === tab.id) setSelected(tabs.find((t) => t.id !== tab.id)?.id)
                }}
              >
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </div>
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            sessionId={session.id}
            cwd={tab.cwd}
            active={active && selected === tab.id}
            focused={focused && selected === tab.id}
          />
        ))}
        {!tabs.length && (
          <Empty title="No open terminals">
            Open a new terminal to start an interactive SSH shell.
          </Empty>
        )}
      </div>
    </div>
  )
}
