import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Search, Workflow } from 'lucide-react'
import { rpc, errorText } from '../../app/api'
import { useAction } from '../../hooks/use-action'
import { ErrorMessage, Loading, Modal, PageHeading } from '../../components/ui'
import type { ServiceAction } from '../../../../domain/monitoring/types'
export function Services({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const query = useQuery({
    queryKey: ['services', sessionId],
    queryFn: () => rpc('services.list', { sessionId }),
    enabled: active,
  })
  const [search, setSearch] = useState('')
  const [name, setName] = useState<string>()
  const [logs, setLogs] = useState(false)
  const detail = useQuery({
    queryKey: ['service-detail', sessionId, name, logs],
    queryFn: () =>
      name
        ? logs
          ? rpc('logs.read', { sessionId, name })
          : rpc('services.details', { sessionId, name })
        : Promise.resolve(''),
    enabled: active && !!name,
  })
  const { busy, run } = useAction()
  const action = (action: ServiceAction) => {
    if (name)
      void run(async () => {
        await rpc('services.action', { sessionId, name, action })
        await query.refetch()
        await detail.refetch()
      })
  }
  return (
    <div className="page">
      <PageHeading
        title="Services"
        description="Inspect and manage services discovered from systemd."
      >
        <button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeading>
      <div className="panel">
        <div className="table-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Filter services"
              placeholder="Filter services…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="muted">{query.data?.length ?? 0} services</span>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorMessage error={errorText(query.error)} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Substate</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {query.data
                  ?.filter((s) =>
                    `${s.name} ${s.description}`.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((s) => (
                    <tr
                      key={s.name}
                      onDoubleClick={() => {
                        setName(s.name)
                        setLogs(false)
                      }}
                    >
                      <td>
                        <button
                          className="file-name"
                          onClick={() => {
                            setName(s.name)
                            setLogs(false)
                          }}
                        >
                          <Workflow size={16} />
                          {s.name}
                        </button>
                      </td>
                      <td>
                        <span
                          className={`badge ${s.active === 'active' ? 'live' : s.active === 'failed' ? 'failed' : ''}`}
                        >
                          {s.active}
                        </span>
                      </td>
                      <td>{s.sub}</td>
                      <td className="muted">{s.description}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {name && (
        <Modal
          title={name}
          description="Service actions require your account’s existing authorization. Sensitive actions ask for confirmation."
          onClose={() => setName(undefined)}
          wide
        >
          <div className="service-actions">
            <button onClick={() => setLogs(!logs)}>{logs ? 'Details' : 'Recent logs'}</button>
            {(['start', 'stop', 'restart', 'enable', 'disable'] as const).map((a) => (
              <button disabled={busy} key={a} onClick={() => action(a)}>
                {a}
              </button>
            ))}
            {detail.data?.includes('CanReload=yes') && (
              <button disabled={busy} onClick={() => action('reload')}>
                reload
              </button>
            )}
          </div>
          {detail.isFetching ? (
            <Loading />
          ) : detail.error ? (
            <ErrorMessage error={errorText(detail.error)} />
          ) : (
            <pre className="output-pane">{detail.data}</pre>
          )}
        </Modal>
      )}
    </div>
  )
}
