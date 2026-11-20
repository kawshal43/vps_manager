import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { rpc, errorText } from '../../app/api'
import { ErrorMessage, Loading, PageHeading } from '../../components/ui'
import { Modal } from '../../components/ui'
import { useAction } from '../../hooks/use-action'
export function ServerOutput({
  sessionId,
  module,
  embedded = false,
  active = true,
}: {
  sessionId: string
  module: 'logs' | 'applications'
  embedded?: boolean
  active?: boolean
}) {
  const [ports, setPorts] = useState(false)
  const [filter, setFilter] = useState('')
  const [hideKernel, setHideKernel] = useState(true)
  const [inspect, setInspect] = useState(false)
  const [pid, setPid] = useState('')
  const [process, setProcess] = useState<{ pid: number; startTime: string; detail: string }>()
  const { busy, run } = useAction()
  const q = useQuery({
    queryKey: [module, sessionId, ports],
    enabled: active,
    queryFn: () =>
      module === 'logs'
        ? rpc('logs.read', { sessionId })
        : ports
          ? rpc('system.ports', { sessionId })
          : rpc('system.processes', { sessionId }),
  })
  return (
    <div className={embedded ? 'embedded-processes' : 'page'}>
      <PageHeading
        title={module === 'logs' ? 'Server logs' : 'Processes & ports'}
        description={
          module === 'logs'
            ? 'The latest 200 journal entries visible to your account.'
            : 'Processes and listening ports reported by the server.'
        }
      >
        {module === 'applications' && (
          <button
            onClick={() => {
              setInspect(true)
              setProcess(undefined)
            }}
          >
            Inspect process…
          </button>
        )}
        {module === 'applications' && (
          <button onClick={() => setPorts(!ports)}>
            {ports ? 'View processes' : 'View listening ports'}
          </button>
        )}
        <button disabled={q.isFetching} onClick={() => void q.refetch()}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeading>
      {module === 'applications' && (
        <div className="process-filters">
          <input
            aria-label="Filter processes or ports"
            placeholder="Filter by command, user, PID or port…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {!ports && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hideKernel}
                onChange={(e) => setHideKernel(e.target.checked)}
              />
              Hide kernel threads
            </label>
          )}
        </div>
      )}
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={errorText(q.error)} />
      ) : (
        <pre className="output-pane full-output">
          {module === 'logs'
            ? q.data || 'The server returned no entries.'
            : q.data
                ?.split('\n')
                .filter(
                  (line, i) =>
                    i === 0 ||
                    ((!hideKernel || ports || !/\[[^\]]+\]\s*$/.test(line)) &&
                      line.toLowerCase().includes(filter.toLowerCase())),
                )
                .join('\n') || 'No matching entries.'}
        </pre>
      )}
      {inspect && (
        <Modal
          title="Inspect process"
          description="Inspect a process identity before sending a termination signal. Your existing Linux permissions apply."
          onClose={() => setInspect(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () =>
                setProcess(await rpc('system.inspect', { sessionId, pid: Number(pid) })),
              )
            }}
          >
            <label>
              Process ID
              <input
                required
                autoFocus
                type="number"
                min="2"
                max="4194304"
                value={pid}
                onChange={(e) => {
                  setPid(e.target.value)
                  setProcess(undefined)
                }}
              />
            </label>
            <div className="dialog-actions">
              <button disabled={busy}>Inspect</button>
            </div>
          </form>
          {process && (
            <>
              <pre className="output-pane">{process.detail}</pre>
              <p className="muted">
                Start time: {process.startTime} clock ticks. The identity is rechecked before
                signaling.
              </p>
              <div className="dialog-actions">
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      await rpc('system.terminate', {
                        sessionId,
                        pid: process.pid,
                        startTime: process.startTime,
                      })
                      setInspect(false)
                      await q.refetch()
                    })
                  }}
                >
                  Send SIGTERM…
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
