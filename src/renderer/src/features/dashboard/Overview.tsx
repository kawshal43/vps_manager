import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  ArrowRight,
  Cpu,
  Files,
  HardDrive,
  MemoryStick,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Workflow,
} from 'lucide-react'
import type { ServerSession } from '../../../../domain/connection/types'
import { rpc, errorText } from '../../app/api'
import { useApp, type Module } from '../../app/store'
import { bytes, ErrorMessage, Loading, PageHeading } from '../../components/ui'
export function Overview({
  session,
  monitoring = false,
  onNavigate,
  active = true,
}: {
  session: ServerSession
  monitoring?: boolean
  onNavigate?: (module: Module) => void
  active?: boolean
}) {
  const interval = useApp((s) => s.preferences.monitoringInterval)
  const query = useQuery({
    queryKey: ['metrics', session.id],
    queryFn: () => rpc('monitoring.get', { sessionId: session.id }),
    refetchInterval: interval * 1000,
    enabled: active && session.state === 'CONNECTED',
  })
  const m = query.data
  const gauges = m
    ? [
        {
          title: 'CPU utilization',
          value: m.cpuPercent,
          description: `${m.cpuCount} logical cores`,
          icon: Cpu,
          detail: m.cpuPercent === null ? 'Sampling…' : `${m.cpuPercent.toFixed(1)}%`,
        },
        {
          title: 'Memory usage',
          value: 100 * (1 - m.memoryAvailable / m.memoryTotal),
          description: `${bytes(m.memoryTotal - m.memoryAvailable)} of ${bytes(m.memoryTotal)}`,
          icon: MemoryStick,
          detail: `${(100 * (1 - m.memoryAvailable / m.memoryTotal)).toFixed(1)}%`,
        },
        {
          title: 'Root filesystem',
          value: (100 * m.diskUsed) / m.diskTotal,
          description: `${bytes(m.diskUsed)} of ${bytes(m.diskTotal)}`,
          icon: HardDrive,
          detail: `${((100 * m.diskUsed) / m.diskTotal).toFixed(1)}%`,
        },
      ]
    : []
  return (
    <div className="page">
      <PageHeading
        title={monitoring ? 'Monitoring' : 'Server overview'}
        description={
          monitoring
            ? `Live system resources · refreshes every ${interval} seconds`
            : 'Your server, at a glance.'
        }
      >
        <span className="badge live">
          <span className="status-dot" />
          Live connection
        </span>
        <button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeading>
      <div className="server-summary">
        <div className="ubuntu-symbol">u</div>
        <div>
          <h2>{session.hostname}</h2>
          <p>
            {session.distribution || 'Linux server'} <span>·</span> {session.architecture}
          </p>
        </div>
        <div className="server-address">
          <span>SSH ENDPOINT</span>
          <code>
            {session.profile.username}@{session.profile.host}:{session.profile.port}
          </code>
        </div>
      </div>
      {query.error && <ErrorMessage error={errorText(query.error)} />}{' '}
      {query.isPending ? (
        <Loading label="Reading system resources…" />
      ) : (
        <div className="metric-grid">
          {gauges.map((g) => (
            <div className="metric-card" key={g.title}>
              <div className="metric-title">
                <span>{g.title}</span>
                <g.icon size={18} />
              </div>
              <div className="metric-value">{g.detail}</div>
              <div className="meter">
                <span style={{ width: `${g.value ?? 0}%` }} />
              </div>
              <p>{g.description}</p>
            </div>
          ))}
        </div>
      )}
      <div className="overview-columns">
        <section className="panel">
          <div className="panel-heading">
            <h3>System information</h3>
            <span className="badge">Ubuntu workspace</span>
          </div>
          <dl className="info-list">
            <div>
              <dt>Uptime</dt>
              <dd>
                {m
                  ? `${Math.floor(m.uptime / 86400)}d ${Math.floor(m.uptime / 3600) % 24}h ${Math.floor(m.uptime / 60) % 60}m`
                  : 'Waiting for server'}
              </dd>
            </div>
            <div>
              <dt>Load average (1 / 5 / 15 min)</dt>
              <dd>{m?.load.map((v) => v.toFixed(2)).join(' / ') ?? 'Waiting for server'}</dd>
            </div>
            <div>
              <dt>Swap used</dt>
              <dd>
                {m
                  ? `${bytes(m.swapTotal - m.swapFree)} / ${bytes(m.swapTotal)}`
                  : 'Waiting for server'}
              </dd>
            </div>
            <div>
              <dt>Home directory</dt>
              <dd>
                <code>{session.home}</code>
              </dd>
            </div>
            <div>
              <dt>File management</dt>
              <dd className={session.sftp ? 'success-text' : 'warning-text'}>
                {session.sftp ? 'SFTP available' : 'SFTP unavailable'}
              </dd>
            </div>
            <div>
              <dt>Last sample</dt>
              <dd>{m ? new Date(m.at).toLocaleTimeString() : 'Waiting for server'}</dd>
            </div>
          </dl>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>Quick access</h3>
          </div>
          <div className="quick-actions">
            {[
              {
                module: 'files' as const,
                icon: Files,
                title: 'Browse server files',
                detail: 'Open your remote home directory',
                disabled: !session.sftp,
              },
              {
                module: 'terminal' as const,
                icon: Terminal,
                title: 'Open SSH terminal',
                detail: 'A real, interactive shell',
              },
              {
                module: 'services' as const,
                icon: Workflow,
                title: 'Manage services',
                detail: 'Inspect systemd services and logs',
              },
              {
                module: 'transfers' as const,
                icon: ArrowDownToLine,
                title: 'View transfers',
                detail: 'Track uploads and downloads',
              },
            ].map((a) => (
              <button key={a.module} disabled={a.disabled} onClick={() => onNavigate?.(a.module)}>
                <span className="quick-icon">
                  <a.icon size={20} />
                </span>
                <span>
                  <strong>{a.title}</strong>
                  <small>{a.detail}</small>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
      </div>
      <div className="security-strip">
        <ShieldCheck size={20} />
        <div>
          <strong>Connected with your account’s permissions</strong>
          <p>
            GUI operations use your existing Linux access. VPS Manager never silently elevates
            privileges.
          </p>
        </div>
      </div>
    </div>
  )
}
