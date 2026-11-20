import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useApp } from './store'
import { rpc, errorText } from './api'
import { IconButton } from '../components/ui'
import { ConnectionScreen, HostKeyDialog } from '../features/connections/ConnectionScreen'
import { Desktop } from '../desktop/Desktop'

export function App() {
  const sessions = useApp((s) => s.sessions)
  const activeId = useApp((s) => s.activeId)
  const error = useApp((s) => s.error)
  const theme = useApp((s) => s.preferences.theme)
  const [newConnection, setNewConnection] = useState(false)
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: () => rpc('app.bootstrap', {}) })
  useEffect(() => {
    if (!bootstrap.data) return
    const current = useApp.getState()
    current.set({ preferences: bootstrap.data.preferences })
    if (!current.sessions.length)
      current.set({
        sessions: bootstrap.data.sessions,
        jobs: bootstrap.data.transfers,
        activeId: bootstrap.data.sessions.find((s) => s.state === 'CONNECTED')?.id,
      })
  }, [bootstrap.data])
  useEffect(
    () =>
      window.vps.onEvent((event) => {
        const state = useApp.getState()
        if (event.type === 'session') {
          state.updateSession(event.session)
          if (
            event.session.state !== 'VERIFYING_HOST_KEY' &&
            state.challenge?.sessionId === event.session.id
          )
            state.set({ challenge: undefined })
        } else if (event.type === 'host-challenge') state.set({ challenge: event.challenge })
        else if (event.type === 'transfer') state.updateJob(event.job)
      }),
    [],
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      document.documentElement.dataset.theme =
        theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [theme])
  const session = sessions.find((s) => s.id === activeId)
  const disconnect = async () => {
    if (
      !session ||
      !window.confirm(
        'Disconnect from this server? Active transfers and terminal sessions will close. Unsaved editor changes stay in their windows.',
      )
    )
      return
    try {
      await rpc('connection.disconnect', { sessionId: session.id })
    } catch (e) {
      useApp.getState().set({ error: errorText(e) })
    }
  }
  return (
    <>
      <Desktop onConnect={() => setNewConnection(true)} onDisconnect={() => void disconnect()} />
      {(!session || newConnection) && (
        <div className="desktop-connection-layer">
          <ConnectionScreen onClose={session ? () => setNewConnection(false) : undefined} />
        </div>
      )}
      <HostKeyDialog />
      {(error || bootstrap.error) && (
        <div className="error-toast" role="alert">
          <div>
            <strong>Operation could not be completed</strong>
            <p>{error || errorText(bootstrap.error)}</p>
          </div>
          <IconButton
            title="Dismiss error"
            onClick={() => useApp.getState().set({ error: undefined })}
          >
            <X size={17} />
          </IconButton>
        </div>
      )}
    </>
  )
}
