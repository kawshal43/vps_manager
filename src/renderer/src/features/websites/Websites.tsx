import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Globe,
  RefreshCw,
  Plus,
  FolderOpen,
  Terminal,
  ExternalLink,
  Upload,
  RotateCcw,
  Search,
  Activity,
} from 'lucide-react'
import type { ServerSession } from '../../../../domain/connection/types'
import {
  defaultProtectedPaths,
  websiteInputSchema,
  type WebsiteView,
  type WebsiteInput,
  type DeploymentPreview,
  type DeploymentProgress,
  type DeploymentHistory,
  type HealthResult,
  type Elevation,
  type UpdateSource,
  type UpdateMethod,
} from '../../../../domain/websites/types'
import { rpc, errorText } from '../../app/api'
import { bytes, Empty, ErrorMessage, Loading, Modal, PageHeading } from '../../components/ui'
import './websites.css'

const split = (text: string) =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
const runtimeState = (site: WebsiteView) =>
  !site.services.length
    ? 'unknown'
    : site.services.every((s) => s.state === 'running')
      ? 'running'
      : site.services.every((s) => s.state !== 'running')
        ? 'stopped'
        : 'mixed'
const date = (value?: string) => (value ? new Date(value).toLocaleString() : 'Not recorded')

function WebsiteForm({
  site,
  sessionId,
  onClose,
  onSaved,
}: {
  site?: WebsiteView
  sessionId: string
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const c = site?.record?.config,
    suggested = site?.suggestedCompose
  const [name, setName] = useState(c?.name ?? site?.name ?? '')
  const [domain, setDomain] = useState(c?.domain ?? site?.domain ?? '')
  const [path, setPath] = useState(c?.projectPath ?? site?.projectPath ?? '')
  const [strategy, setStrategy] = useState<WebsiteInput['strategy']>(
    c?.strategy ?? (suggested ? 'compose' : 'manual'),
  )
  const [project, setProject] = useState(c?.compose?.project ?? suggested?.project ?? '')
  const [files, setFiles] = useState(
    c?.compose?.files.join('\n') ?? suggested?.files.join('\n') ?? 'compose.yml',
  )
  const [services, setServices] = useState(
    c?.compose?.services.join(', ') ??
      suggested?.services.filter((s) => /^(web|api|app|frontend|backend)$/.test(s)).join(', ') ??
      '',
  )
  const [env, setEnv] = useState(c?.compose?.envFile ?? '')
  const [health, setHealth] = useState(
    c?.healthUrl ?? (site?.domain ? `${site.https ? 'https' : 'http'}://${site.domain}/` : ''),
  )
  const [publicUrl, setPublicUrl] = useState(
    c?.publicUrl ?? (site?.domain ? `${site.https ? 'https' : 'http'}://${site.domain}/` : ''),
  )
  const [healthTimeout, setHealthTimeout] = useState(c?.healthTimeoutSeconds ?? 60)
  const [protectedPaths, setProtectedPaths] = useState(
    (c?.protectedPaths ?? defaultProtectedPaths).join('\n'),
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Modal
      title={c ? 'Configure website' : 'Import website'}
      description="Register a verified application directory in this server/account workspace. Importing does not change the server."
      onClose={() => {
        if (!busy) onClose()
      }}
      wide
    >
      <form
        className="website-form"
        onSubmit={(event) => {
          event.preventDefault()
          setError('')
          const parsed = websiteInputSchema.safeParse({
            name,
            domain,
            projectPath: path,
            strategy,
            healthUrl: health,
            publicUrl,
            healthTimeoutSeconds: healthTimeout,
            protectedPaths: split(protectedPaths),
            ...(strategy === 'compose'
              ? {
                  compose: {
                    project,
                    files: split(files),
                    services: split(services),
                    ...(env ? { envFile: env } : {}),
                  },
                }
              : {}),
          })
          if (!parsed.success) {
            setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '))
            return
          }
          setBusy(true)
          void rpc('websites.save', { sessionId, websiteId: site?.record?.id, config: parsed.data })
            .then((record) => onSaved(record.id))
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false))
        }}
      >
        <div className="website-form-grid">
          <label>
            Website name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Domain
            <input
              required
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </label>
          <label className="website-wide">
            Project directory
            <input
              required
              placeholder="/home/ubuntu/my-website"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <label>
            Deployment adapter
            <select
              aria-label="Deployment adapter"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as WebsiteInput['strategy'])}
            >
              <option value="compose">Docker Compose</option>
              <option value="static">Prebuilt static website</option>
              <option value="manual">Manual runtime · inspection only</option>
            </select>
          </label>
          <label>
            Application health endpoint
            <input
              required
              placeholder="http://127.0.0.1:3000/health"
              value={health}
              onChange={(e) => setHealth(e.target.value)}
            />
          </label>
          <label>
            Public website URL
            <input
              required
              placeholder="https://example.com/"
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
            />
          </label>
          <label>
            Health readiness timeout (seconds)
            <input
              required
              type="number"
              min={10}
              max={300}
              value={healthTimeout}
              onChange={(e) => setHealthTimeout(Number(e.target.value))}
            />
          </label>
          {strategy === 'compose' && (
            <>
              <label>
                Existing Compose project name
                <input required value={project} onChange={(e) => setProject(e.target.value)} />
              </label>
              <label>
                Application services to build/restart
                <input
                  required
                  placeholder="web, api"
                  value={services}
                  onChange={(e) => setServices(e.target.value)}
                />
              </label>
              <label>
                Compose files, relative to project
                <textarea
                  required
                  rows={2}
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                />
              </label>
              <label>
                Existing environment file (optional)
                <input
                  placeholder="/etc/myapp/settings.env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                />
                <small>Its contents are never shown or replaced.</small>
              </label>
            </>
          )}
          <label className="website-wide">
            Additional protected paths, relative to project
            <textarea
              rows={2}
              value={protectedPaths}
              onChange={(e) => setProtectedPaths(e.target.value)}
            />
          </label>
        </div>
        <p className="website-note">
          Environment files, keys, certificates, database files and common media/data directories
          are always excluded. Native Node.js, Spring Boot and PHP deployment scripts are not
          supported; containerized builds can use the Compose adapter. Static sites must contain
          prebuilt assets without persistent data.
        </p>
        {c && (
          <p className="website-note">
            Mappings with deployment history are retained for safe recovery and cannot be changed.
            Import a separate website for a different runtime mapping.
          </p>
        )}
        {error && <ErrorMessage error={error} />}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Validating directory…' : 'Save website'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function UpdateWizard({
  site,
  sessionId,
  elevation,
  onClose,
  onStarted,
}: {
  site: WebsiteView
  sessionId: string
  elevation: Elevation
  onClose: () => void
  onStarted: () => void
}) {
  const [method, setMethod] = useState<UpdateMethod>('full')
  const [kind, setKind] = useState<'folder' | 'zip' | 'remote' | 'git'>('folder')
  const [local, setLocal] = useState<{ token: string; name: string }>()
  const [remote, setRemote] = useState(''),
    [url, setUrl] = useState(''),
    [revision, setRevision] = useState(''),
    [paths, setPaths] = useState('')
  const [preview, setPreview] = useState<DeploymentPreview>(),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const close = () => {
    if (busy) return
    if (preview) void rpc('websites.discard', { sessionId, token: preview.token }).catch(() => {})
    onClose()
  }
  const inspect = async () => {
    setBusy(true)
    setError('')
    try {
      let source: UpdateSource
      if (method === 'rebuild') source = { kind: 'current' }
      else if (kind === 'remote') source = { kind: 'remote', path: remote }
      else if (kind === 'git') source = { kind: 'git', url, revision }
      else {
        if (!local) throw new Error('Select a project source first.')
        source = { kind: 'local', token: local.token }
      }
      setPreview(
        await rpc('websites.prepare', {
          sessionId,
          websiteId: site.id,
          method,
          source,
          elevation,
          paths: split(paths),
        }),
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Update ${site.name}`}
      description={`${site.domain} · ${site.projectPath} · ${site.record?.config.strategy} · ${elevation === 'sudo' ? 'Explicit existing sudo for Docker' : 'Current SSH account'}`}
      onClose={close}
      wide
    >
      <ol className="website-steps">
        <li>1. Website selected</li>
        <li className={!preview ? 'active' : ''}>2. Source & method</li>
        <li className={preview ? 'active' : ''}>3. Inspect & approve</li>
      </ol>
      {!preview ? (
        <div className="website-form">
          <label>
            Update method
            <select
              aria-label="Update method"
              value={method}
              disabled={busy}
              onChange={(e) => setMethod(e.target.value as UpdateMethod)}
            >
              <option value="full">Full project update</option>
              <option value="partial">Partial update · selected files/directories</option>
              <option value="rebuild">Rebuild current deployed source</option>
            </select>
          </label>
          {method !== 'rebuild' && (
            <>
              <label>
                Update source
                <select
                  aria-label="Update source"
                  value={kind}
                  disabled={busy}
                  onChange={(e) => {
                    setKind(e.target.value as typeof kind)
                    setLocal(undefined)
                  }}
                >
                  <option value="folder">Local Windows project folder</option>
                  <option value="zip">ZIP archive</option>
                  <option value="remote">Existing remote source directory</option>
                  <option value="git">Git revision · new isolated checkout</option>
                </select>
              </label>
              {(kind === 'folder' || kind === 'zip') && (
                <div className="website-source-picker">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      setError('')
                      void rpc('websites.pickSource', { sessionId, kind })
                        .then((v) => {
                          if (v) setLocal(v)
                        })
                        .catch((e) => setError(errorText(e)))
                        .finally(() => setBusy(false))
                    }}
                  >
                    <FolderOpen size={15} />
                    Select {kind === 'folder' ? 'folder' : 'ZIP archive'}
                  </button>
                  <span>{local?.name || 'No source selected'}</span>
                </div>
              )}
              {kind === 'remote' && (
                <label>
                  Source directory on this server
                  <input
                    disabled={busy}
                    value={remote}
                    placeholder="/home/ubuntu/new-source"
                    onChange={(e) => setRemote(e.target.value)}
                  />
                </label>
              )}
              {kind === 'git' && (
                <>
                  <label>
                    Repository URL
                    <input
                      disabled={busy}
                      placeholder="https://github.com/owner/project.git"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Exact Git commit (40 hexadecimal characters)
                    <input
                      disabled={busy}
                      value={revision}
                      onChange={(e) => setRevision(e.target.value)}
                    />
                  </label>
                  <p className="website-note">
                    Uses existing repository access on the VPS and a new checkout. It never pulls
                    into your development directory or pushes changes. HTTPS credentials in URLs are
                    rejected. Preparing a Git preview creates an isolated source checkout on the
                    server.
                  </p>
                </>
              )}
              {method === 'partial' && (
                <label>
                  Relative files/directories to include
                  <textarea
                    disabled={busy}
                    rows={3}
                    placeholder={'src/frontend\npublic/assets'}
                    value={paths}
                    onChange={(e) => setPaths(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <p className="website-note">
            A verified application backup is required before activation. Environment files,
            persistent data, certificates, shared routing and unselected services stay in place. ZIP
            archives with one top-level folder use that folder as the source root.
          </p>
          <div className="modal-actions">
            <button disabled={busy} onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={() => void inspect()}>
              {busy ? 'Inspecting source and runtime…' : 'Inspect deployment'}
            </button>
          </div>
        </div>
      ) : (
        <div className="website-preview">
          <div className="website-preview-summary">
            <strong>
              {preview.fileCount.toLocaleString()} files · {bytes(preview.bytes)}
            </strong>
            <span>
              {preview.services.length
                ? `Rebuild/recreate: ${preview.services.join(', ')}`
                : 'Publish static assets'}{' '}
              · {bytes(preview.freeBytes)} free
            </span>
          </div>
          <div className="website-diff-grid">
            {(['added', 'changed', 'removed'] as const).map((key) => (
              <details key={key}>
                <summary>
                  {key[0].toUpperCase() + key.slice(1)} · {preview.changes[key].length}
                </summary>
                <ul>
                  {preview.changes[key].slice(0, 200).map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                {preview.changes[key].length > 200 && <p>First 200 paths shown.</p>}
              </details>
            ))}
          </div>
          <details>
            <summary>Protected resources · {preview.protected.length}</summary>
            <ul>
              {preview.protected.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </details>
          {preview.warnings.map((w) => (
            <p className="website-note" key={w}>
              {w}
            </p>
          ))}
          {!!preview.blocked.length && (
            <div className="website-blockers" role="alert">
              <strong>Deployment blocked</strong>
              <ul>
                {preview.blocked.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="website-checkbox">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy || !!preview.blocked.length}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed the source/startup code and confirm this update performs no database
            migration. I understand application rollback does not restore databases or media.
          </label>
          <div className="modal-actions">
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void rpc('websites.discard', { sessionId, token: preview.token })
                  .then(() => {
                    setPreview(undefined)
                    setAck(false)
                  })
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Back
            </button>
            <button
              className="primary"
              disabled={busy || !ack || !!preview.blocked.length}
              onClick={() => {
                setBusy(true)
                setError('')
                void rpc('websites.deploy', { sessionId, token: preview.token, acknowledged: ack })
                  .then((id) => {
                    if (id) onStarted()
                  })
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Waiting for confirmation…' : 'Back up & deploy'}
            </button>
          </div>
        </div>
      )}
      {error && <ErrorMessage error={error} />}
    </Modal>
  )
}

export function Websites({
  session,
  active,
  openFolder,
  openTerminal,
  openEditor,
}: {
  session: ServerSession
  active: boolean
  openFolder: (path: string) => void
  openTerminal: (path: string) => void
  openEditor: (path: string) => void
}) {
  const sessionId = session.id,
    client = useQueryClient()
  const [sudo, setSudo] = useState(false),
    elevation: Elevation = sudo ? 'sudo' : 'none'
  const [search, setSearch] = useState(''),
    [statusFilter, setStatusFilter] = useState('all'),
    [technologyFilter, setTechnologyFilter] = useState('all'),
    [deploymentFilter, setDeploymentFilter] = useState('all')
  const [selected, setSelected] = useState<string>(),
    [tab, setTab] = useState<'overview' | 'logs' | 'history' | 'configuration'>('overview')
  const [form, setForm] = useState<{ site?: WebsiteView }>(),
    [update, setUpdate] = useState<WebsiteView>(),
    [restore, setRestore] = useState<DeploymentHistory>(),
    [restoreAck, setRestoreAck] = useState(false)
  const [operations, setOperations] = useState<Record<string, DeploymentProgress>>({}),
    [manualHealth, setHealth] = useState<Record<string, HealthResult>>({})
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [liveLogs, setLiveLogs] = useState(false)
  const [historyLog, setHistoryLog] = useState<DeploymentHistory>()
  const [clock, setClock] = useState(() => Date.now())
  const query = useQuery({
    queryKey: ['websites', sessionId, elevation],
    queryFn: () => rpc('websites.discover', { sessionId, elevation }),
    enabled: active,
  })
  const allSites = query.data?.websites ?? [],
    site = allSites.find((s) => s.id === selected) ?? allSites[0]
  const registered = !!site?.record
  const healthQuery = useQuery({
    queryKey: ['website-health', sessionId, site?.id],
    queryFn: () => rpc('websites.health', { sessionId, websiteId: site!.id }),
    enabled: active && registered,
    staleTime: 60000,
  })
  const health =
    site && healthQuery.data ? { [site.id]: healthQuery.data, ...manualHealth } : manualHealth
  const operation = Object.values(operations)
    .filter((o) => o.websiteId === site?.id)
    .at(-1)
  const running = operation?.state === 'running'
  useEffect(() => {
    if (!active || !running) return
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, running])
  const elapsed = operation
    ? Math.max(
        1,
        Math.round(
          ((operation.finishedAt ? Date.parse(operation.finishedAt) : clock) -
            Date.parse(operation.startedAt)) /
            1000,
        ),
      )
    : 0
  const history = useQuery({
    queryKey: ['website-history', sessionId, site?.id],
    queryFn: () => rpc('websites.history', { sessionId, websiteId: site!.id }),
    enabled: active && registered && tab === 'history',
  })
  const logs = useQuery({
    queryKey: ['website-logs', sessionId, site?.id, elevation],
    queryFn: () => rpc('websites.logs', { sessionId, websiteId: site!.id, elevation }),
    enabled: active && registered && tab === 'logs',
    refetchInterval: active && liveLogs && tab === 'logs' ? 3000 : false,
  })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void rpc('websites.operations', { sessionId })
      .then((items) => {
        if (!cancelled)
          setOperations((old) => ({ ...old, ...Object.fromEntries(items.map((i) => [i.id, i])) }))
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e))
      })
    return () => {
      cancelled = true
    }
  }, [active, sessionId])
  useEffect(
    () =>
      window.vps.onEvent((event) => {
        if (event.type !== 'website-deployment' || event.operation.sessionId !== sessionId) return
        setOperations((old) => ({ ...old, [event.operation.id]: event.operation }))
        if (event.operation.state !== 'running') {
          void client.invalidateQueries({ queryKey: ['website-history', sessionId] })
          void client.invalidateQueries({ queryKey: ['websites', sessionId] })
        }
      }),
    [client, sessionId],
  )
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const visible = allSites.filter(
    (s) =>
      `${s.name} ${s.domain} ${s.aliases.join(' ')} ${s.technology}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (statusFilter === 'all' || runtimeState(s) === statusFilter) &&
      (technologyFilter === 'all' || s.technology === technologyFilter) &&
      (deploymentFilter === 'all' || (s.record?.config.strategy ?? 'import') === deploymentFilter),
  )
  return (
    <div className="websites-page">
      <PageHeading
        title="Websites & Deployments"
        eyebrow="HOSTED ON THIS SERVER"
        description={`${session.profile.displayName || session.profile.host} · ${session.profile.username}@${session.profile.host}`}
      >
        <button disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
          <RefreshCw size={15} />
          Discover
        </button>
        <button className="primary" onClick={() => setForm({})}>
          <Plus size={15} />
          Import website
        </button>
      </PageHeading>
      <div className="website-controls">
        <label className="website-search">
          <Search size={15} />
          <input
            aria-label="Search websites"
            value={search}
            placeholder="Search domains and websites…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter runtime status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All runtime states</option>
          {['running', 'stopped', 'mixed', 'unknown'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="Filter website technology"
          value={technologyFilter}
          onChange={(e) => setTechnologyFilter(e.target.value)}
        >
          <option value="all">All technologies</option>
          {[...new Set(allSites.map((s) => s.technology))].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="Filter deployment adapter"
          value={deploymentFilter}
          onChange={(e) => setDeploymentFilter(e.target.value)}
        >
          <option value="all">All deployment types</option>
          <option value="compose">Docker Compose</option>
          <option value="static">Static assets</option>
          <option value="manual">Manual runtime</option>
          <option value="import">Import required</option>
        </select>
      </div>
      <div className="website-tools">
        <label className="website-checkbox">
          <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
          Use existing noninteractive sudo for Docker / Nginx
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () =>
              setNotice(await rpc('websites.nginx', { sessionId, elevation, reload: false })),
            )
          }
        >
          Test Nginx
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () =>
              setNotice(await rpc('websites.nginx', { sessionId, elevation, reload: true })),
            )
          }
        >
          Reload Nginx…
        </button>
      </div>
      {(error || query.error) && <ErrorMessage error={error || errorText(query.error)} />}
      {notice && (
        <p role="status" className="website-note">
          {notice}
        </p>
      )}
      {!!query.data?.warnings.length && (
        <details className="website-discovery-warnings">
          <summary>Discovery notes · {query.data.warnings.length}</summary>
          <ul>
            {query.data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {query.isLoading ? (
        <Loading label="Reading hosting configuration…" />
      ) : !allSites.length ? (
        <Empty title="No websites discovered">
          Import an existing project directory, or check Nginx/Docker access. Discovery never
          changes hosted services.
        </Empty>
      ) : (
        <div className="website-workspace">
          <nav className="website-list" aria-label="Hosted websites">
            {visible.map((s) => (
              <button
                key={s.id}
                className={site?.id === s.id ? 'selected' : ''}
                aria-pressed={site?.id === s.id}
                onClick={() => {
                  setSelected(s.id)
                  setHistoryLog(undefined)
                  setTab('overview')
                }}
              >
                <span className={`website-state ${runtimeState(s)}`} />
                <span>
                  <strong>{s.name}</strong>
                  <span>{s.domain || 'Domain not identified'}</span>
                  <small>
                    {s.technology} ·{' '}
                    {s.support === 'import'
                      ? 'Import required'
                      : s.support === 'partial'
                        ? 'Inspection only'
                        : s.record?.config.strategy}
                  </small>
                </span>
              </button>
            ))}
            {!visible.length && <p className="website-note">No websites match these filters.</p>}
          </nav>
          {site && (
            <section className="website-details" aria-label="Website details">
              <header>
                <div>
                  <h2>
                    <Globe size={21} />
                    {site.name}
                  </h2>
                  <p>
                    {site.domain || 'No domain mapping'}
                    {site.aliases.length ? ` · ${site.aliases.join(', ')}` : ''}
                  </p>
                </div>
                <button
                  disabled={!site.domain}
                  onClick={() =>
                    void act(() =>
                      rpc('shell.openExternal', {
                        url:
                          site.record?.config.publicUrl ??
                          `${site.https ? 'https' : 'http'}://${site.domain}`,
                      }),
                    )
                  }
                >
                  <ExternalLink size={14} />
                  Open website
                </button>
              </header>
              <div className="website-actions">
                <button
                  className="primary"
                  disabled={
                    !registered || site.record?.config.strategy === 'manual' || running || busy
                  }
                  onClick={() => setUpdate(site)}
                >
                  <Upload size={14} />
                  Update website
                </button>
                <button onClick={() => setForm({ site })}>Configure website</button>
                <button
                  disabled={!site.projectPath}
                  onClick={() => site.projectPath && openFolder(site.projectPath)}
                >
                  <FolderOpen size={14} />
                  Files
                </button>
                <button
                  disabled={!site.projectPath}
                  onClick={() => site.projectPath && openTerminal(site.projectPath)}
                >
                  <Terminal size={14} />
                  Terminal
                </button>
                <button
                  disabled={
                    !registered || running || busy || site.record?.config.strategy !== 'compose'
                  }
                  onClick={() =>
                    void act(async () => {
                      await rpc('websites.restart', { sessionId, websiteId: site.id, elevation })
                      await query.refetch()
                    })
                  }
                >
                  <RotateCcw size={14} />
                  Restart…
                </button>
              </div>
              {!registered && (
                <p className="website-note">
                  {site.projectPath
                    ? 'Import this website to verify and save its deployment mapping before updating.'
                    : 'Deployment source not identified — Import or configure website.'}
                </p>
              )}
              <nav className="website-tabs" aria-label="Website detail tabs">
                {(['overview', 'logs', 'history', 'configuration'] as const).map((t) => (
                  <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
                    {t === 'history' ? 'Deployment history' : t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </nav>
              {tab === 'overview' && (
                <>
                  <dl className="website-facts">
                    <div>
                      <dt>Runtime process</dt>
                      <dd>{runtimeState(site)}</dd>
                    </div>
                    <div>
                      <dt>Hosting method</dt>
                      <dd>
                        {site.technology} / {site.webServer}
                      </dd>
                    </div>
                    <div>
                      <dt>Application health</dt>
                      <dd>
                        {health[site.id]?.state || 'Not checked'}
                        {health[site.id]?.code ? ` · HTTP ${health[site.id].code}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>HTTPS configuration</dt>
                      <dd>
                        {site.https ? 'Configured' : 'Not detected'}
                        {site.certificate?.expires
                          ? ` · Certificate expires ${date(site.certificate.expires)}`
                          : ''}
                      </dd>
                    </div>
                    <div className="website-wide">
                      <dt>Deployment directory</dt>
                      <dd>{site.projectPath || 'Not identified'}</dd>
                    </div>
                    <div className="website-wide">
                      <dt>Active versioned source</dt>
                      <dd>
                        {site.record?.activeRelease || 'No managed release yet'}
                        {site.record?.activeRelease && (
                          <button onClick={() => openFolder(site.record!.activeRelease!)}>
                            Open release files
                          </button>
                        )}
                      </dd>
                    </div>
                    <div className="website-wide">
                      <dt>Last known deployment</dt>
                      <dd>{date(site.lastDeployment)}</dd>
                    </div>
                  </dl>
                  <div className="website-inline-actions">
                    <button
                      disabled={!registered || busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await rpc('websites.health', {
                            sessionId,
                            websiteId: site.id,
                          })
                          setHealth((old) => ({ ...old, [site.id]: result }))
                        })
                      }
                    >
                      <Activity size={14} />
                      Check application health
                    </button>
                    {health[site.id] && <small>{health[site.id].detail}</small>}
                  </div>
                  <p className="website-note">
                    A running container is a process state. Application health and HTTPS routing are
                    separate checks; server-side results do not prove public reachability from other
                    networks.
                  </p>
                  <h3>Associated services</h3>
                  {site.services.length ? (
                    <table className="website-services">
                      <thead>
                        <tr>
                          <th>Service</th>
                          <th>Runtime</th>
                          <th>Container health</th>
                          <th>Published ports</th>
                        </tr>
                      </thead>
                      <tbody>
                        {site.services.map((s) => (
                          <tr key={s.name}>
                            <td>{s.name}</td>
                            <td>{s.state}</td>
                            <td>{s.health || 'No health check'}</td>
                            <td>{s.ports.join(', ') || 'None'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="website-note">
                      No application process was reliably associated. Import a verified runtime
                      mapping.
                    </p>
                  )}
                </>
              )}
              {tab === 'configuration' && (
                <>
                  <dl className="website-facts">
                    <div>
                      <dt>Server</dt>
                      <dd>{session.profile.host}</dd>
                    </div>
                    <div>
                      <dt>Deployment support</dt>
                      <dd>{site.support}</dd>
                    </div>
                    <div className="website-wide">
                      <dt>Document root / reverse proxy</dt>
                      <dd>{site.documentRoot || site.upstream || 'Not identified'}</dd>
                    </div>
                    <div className="website-wide">
                      <dt>Nginx configuration</dt>
                      <dd>{site.configPath || 'Not identified'}</dd>
                    </div>
                    <div>
                      <dt>Certificate issuer</dt>
                      <dd>{site.certificate?.issuer || 'Unknown / permission restricted'}</dd>
                    </div>
                    <div>
                      <dt>Backup policy</dt>
                      <dd>
                        Verified application snapshot before every activation; persistent data
                        excluded
                      </dd>
                    </div>
                  </dl>
                  {site.configPath && (
                    <button onClick={() => openEditor(site.configPath!)}>
                      Inspect Nginx configuration
                    </button>
                  )}
                  {site.record && (
                    <pre className="website-config">
                      {JSON.stringify(site.record.config, null, 2)}
                    </pre>
                  )}
                  <p className="website-note">
                    Raw Compose environments, certificate keys and production credentials are not
                    displayed. Database/media backups and standalone Node.js, Java, PHP, Apache and
                    Caddy deployment adapters require manual administration.
                  </p>
                </>
              )}
              {tab === 'logs' && (
                <>
                  <div className="website-inline-actions">
                    <label className="website-checkbox">
                      <input
                        type="checkbox"
                        checked={liveLogs}
                        onChange={(e) => setLiveLogs(e.target.checked)}
                      />
                      Refresh application logs every 3 seconds
                    </label>
                    <button
                      disabled={!registered || logs.isFetching}
                      onClick={() => void logs.refetch()}
                    >
                      Refresh logs
                    </button>
                  </div>
                  {logs.error && <ErrorMessage error={errorText(logs.error)} />}
                  <pre className="website-log" aria-label="Application logs">
                    {logs.isLoading
                      ? 'Loading logs…'
                      : logs.data || 'Import a Compose website to view application logs.'}
                  </pre>
                  <p className="website-note">
                    Output is bounded and known environment values are redacted. Avoid printing
                    credentials in application/build code.
                  </p>
                </>
              )}
              {tab === 'history' && (
                <>
                  {history.error && <ErrorMessage error={errorText(history.error)} />}
                  {history.isLoading ? (
                    <Loading />
                  ) : !history.data?.length ? (
                    <p className="website-note">
                      No deployment history for this registered website.
                    </p>
                  ) : (
                    <div className="website-history">
                      {[...history.data].reverse().map((h) => (
                        <article key={h.id}>
                          <div>
                            <strong>
                              {h.action === 'restore' ? 'Application restore' : 'Deployment'} ·{' '}
                              {h.status}
                            </strong>
                            <small>
                              {date(h.startedAt)} · Backup{' '}
                              {h.backupVerified
                                ? `verified · ${bytes(h.backupBytes)}`
                                : 'unavailable'}
                            </small>
                            <details>
                              <summary>Application backup details</summary>
                              <small>
                                ID: {h.id}
                                <br />
                                Source: {h.backupPath || 'Not available'}
                                <br />
                                Includes application source and{' '}
                                {Object.keys(h.previousImages).length} retained service images.
                                Excludes databases, media, environment variables and certificates.
                              </small>
                            </details>
                            <p>{h.message}</p>
                          </div>
                          <button onClick={() => setHistoryLog(h)}>Deployment logs</button>
                          <button
                            disabled={!h.backupVerified || running || busy}
                            onClick={() => {
                              setRestore(h)
                              setRestoreAck(false)
                            }}
                          >
                            Restore previous version…
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  {historyLog && (
                    <pre className="website-log" aria-label="Historical deployment logs">
                      {historyLog.log.join('\n') || historyLog.message}
                    </pre>
                  )}
                </>
              )}
              {operation && (
                <section className="website-progress" aria-live="polite">
                  <div>
                    <strong>{operation.stage}</strong>
                    <span>
                      {operation.state} · {elapsed}s elapsed
                    </span>
                  </div>
                  {operation.total > 0 && (
                    <>
                      <progress
                        value={operation.transferred}
                        max={Math.max(operation.total, operation.transferred)}
                      />
                      <small>
                        {bytes(operation.transferred)} / {bytes(operation.total)} source transfer ·{' '}
                        {bytes(operation.transferred / Math.max(1, elapsed))}/s average
                      </small>
                    </>
                  )}
                  {running && (
                    <button
                      disabled={!operation.cancellable}
                      onClick={() =>
                        void act(() =>
                          rpc('websites.cancel', { sessionId, operationId: operation.id }),
                        )
                      }
                    >
                      {operation.cancellable
                        ? 'Cancel before activation'
                        : 'Activation / verification in progress'}
                    </button>
                  )}
                  <pre className="website-log" aria-label="Live deployment logs">
                    {operation.log.join('\n')}
                  </pre>
                  {operation.state === 'failed' || operation.state === 'interrupted' ? (
                    <button onClick={() => setTab('history')}>Review backups and recovery</button>
                  ) : null}
                </section>
              )}
            </section>
          )}
        </div>
      )}
      {form && (
        <WebsiteForm
          key={form.site?.id || 'new'}
          site={form.site}
          sessionId={sessionId}
          onClose={() => setForm(undefined)}
          onSaved={(id) => {
            setForm(undefined)
            setSelected(id)
            void client.invalidateQueries({ queryKey: ['websites', sessionId] })
          }}
        />
      )}
      {update && (
        <UpdateWizard
          site={update}
          sessionId={sessionId}
          elevation={elevation}
          onClose={() => setUpdate(undefined)}
          onStarted={() => {
            setUpdate(undefined)
            setTab('history')
            void client.invalidateQueries({ queryKey: ['website-history', sessionId] })
          }}
        />
      )}
      {restore && site && (
        <Modal
          title="Restore application backup"
          description={`${site.name} · ${date(restore.startedAt)}`}
          onClose={() => {
            if (!busy) setRestore(undefined)
          }}
        >
          <p>
            This restores only application source/images. Current databases, media, environment
            variables and certificates are not restored. Older code may be incompatible with the
            current database schema.
          </p>
          <label className="website-checkbox">
            <input
              type="checkbox"
              checked={restoreAck}
              disabled={busy}
              onChange={(e) => setRestoreAck(e.target.checked)}
            />
            I reviewed database compatibility and understand this is an application-only restore.
          </label>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setRestore(undefined)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!restoreAck || busy}
              onClick={() =>
                void act(async () => {
                  const id = await rpc('websites.restore', {
                    sessionId,
                    websiteId: site.id,
                    historyId: restore.id,
                    elevation,
                    acknowledged: true,
                  })
                  if (id) setRestore(undefined)
                })
              }
            >
              Verify backup & restore…
            </button>
          </div>
          {error && <ErrorMessage error={error} />}
        </Modal>
      )}
    </div>
  )
}
