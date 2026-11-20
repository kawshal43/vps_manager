import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Box,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Info,
  ListFilter,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react'
import type {
  ApplicationOperation,
  DeploymentInput,
  DeploymentStatus,
  Elevation,
  InstalledPackage,
  RemovalPlan,
} from '../../../../domain/applications/types'
import { rpc, errorText } from '../../app/api'
import { useAction } from '../../hooks/use-action'
import { bytes, Empty, ErrorMessage, Loading, Modal, PageHeading } from '../../components/ui'
import { ServerOutput } from '../services/ServerOutput'

type Tab = 'packages' | 'deployments' | 'processes'
export function Applications({
  sessionId,
  openTerminal,
  active = true,
}: {
  sessionId: string
  openTerminal: (cwd: string) => void
  active?: boolean
}) {
  const [tab, setTab] = useState<Tab>('packages')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('manual')
  const [hideProtected, setHideProtected] = useState(true)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<InstalledPackage>()
  const [form, setForm] = useState<DeploymentInput & { id?: string }>()
  const [plan, setPlan] = useState<RemovalPlan>()
  const [elevation, setElevation] = useState<Elevation>('none')
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    if (!plan) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, plan.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [plan])
  const [operation, setOperation] = useState<ApplicationOperation>()
  const [result, setResult] = useState<string>()
  const [service, setService] = useState<{ name: string; detail: string }>()
  const { busy, run } = useAction()
  const packages = useQuery({
    queryKey: ['applications-packages', sessionId],
    queryFn: () => rpc('applications.packages', { sessionId }),
    enabled: active && tab === 'packages',
  })
  const deployments = useQuery({
    queryKey: ['applications-deployments', sessionId],
    queryFn: () => rpc('applications.deployments', { sessionId }),
    enabled: active && tab === 'deployments',
  })
  useEffect(
    () =>
      window.vps.onEvent((event) => {
        if (event.type === 'application-operation' && event.operation.sessionId === sessionId)
          setOperation(event.operation)
      }),
    [sessionId],
  )
  const visible = useMemo(
    () =>
      (packages.data?.packages ?? []).filter(
        (pkg) =>
          (!hideProtected || !pkg.protectedReason) &&
          (filter === 'all' ||
            (filter === 'manual' && pkg.manual) ||
            (filter === 'automatic' && !pkg.manual) ||
            (filter === 'optional' && (pkg.priority === 'optional' || pkg.priority === 'extra'))) &&
          `${pkg.name} ${pkg.description} ${pkg.version}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [packages.data, hideProtected, filter, search],
  )
  const saved = (deployments.data ?? []).filter((record) =>
    `${record.name} ${record.path} ${record.service ?? ''} ${record.notes}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  const prepare = (kind: 'package' | 'deployment', target: string) => {
    setExpired(false)
    setResult(undefined)
    setOperation(undefined)
    setElevation('none')
    void run(async () => {
      const value = await rpc('applications.prepareRemoval', { sessionId, kind, target })
      setSelected(undefined)
      setPlan(value)
    })
  }
  const refresh = async () => {
    if (tab === 'packages') await packages.refetch()
    else if (tab === 'deployments') await deployments.refetch()
  }
  const execute = () => {
    if (!plan) return
    void run(async () => {
      try {
        const answer = await rpc('applications.executeRemoval', {
          sessionId,
          token: plan.token,
          elevation,
        })
        setResult(answer.message)
      } finally {
        // Removal capabilities are single-use, including cancelled or failed attempts.
        setPlan(undefined)
        await Promise.all([packages.refetch(), deployments.refetch()])
      }
    })
  }
  const pageCount = Math.max(1, Math.ceil(visible.length / 80))
  const currentPage = Math.min(page, pageCount - 1)
  const headerActions = (
    <>
      <button
        disabled={busy}
        onClick={() => {
          setTab('deployments')
          setSearch('')
          setResult(undefined)
          setForm({ name: '', path: '', service: '', notes: '' })
        }}
      >
        <Plus size={16} />
        Add deployed app
      </button>
      {tab !== 'processes' && (
        <button
          disabled={busy || packages.isFetching || deployments.isFetching}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      )}
    </>
  )
  return (
    <div className="page applications-page">
      <PageHeading
        title="Applications"
        description="Find installed Ubuntu packages and manage your registered deployments."
      >
        {headerActions}
      </PageHeading>
      <div className="application-tabs" role="tablist" aria-label="Application sources">
        {(
          [
            { id: 'packages', label: 'Ubuntu packages', icon: Package },
            { id: 'deployments', label: 'My deployments', icon: FolderOpen },
            { id: 'processes', label: 'Processes & ports', icon: Terminal },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => {
              setTab(item.id)
              setSearch('')
              setPage(0)
              setResult(undefined)
            }}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
      {result && (
        <div className="application-result" role="status">
          <ShieldCheck size={17} />
          {result}
        </div>
      )}
      {tab !== 'processes' && (
        <div className="panel application-inventory">
          <div className="application-filters">
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search applications"
                placeholder={
                  tab === 'packages'
                    ? 'Search package name, version or description…'
                    : 'Search saved name, path or service…'
                }
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(0)
                }}
              />
            </div>
            {tab === 'packages' && (
              <>
                <ListFilter size={16} className="muted" />
                <select
                  aria-label="Package filter"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value)
                    setPage(0)
                  }}
                >
                  <option value="manual">Manually marked</option>
                  <option value="all">All installed</option>
                  <option value="automatic">Automatic dependencies</option>
                  <option value="optional">Optional priority</option>
                </select>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={hideProtected}
                    onChange={(event) => {
                      setHideProtected(event.target.checked)
                      setPage(0)
                    }}
                  />
                  Hide protected system packages
                </label>
              </>
            )}
          </div>
          {tab === 'packages' ? (
            <>
              <div className="application-help">
                <Info size={15} />
                <span>
                  APT’s manual mark can include preinstalled software. “Optional” is package
                  priority; it does not mean unused or safe to remove.
                </span>
              </div>
              {packages.isPending ? (
                <Loading label="Reading installed packages from Ubuntu…" />
              ) : packages.error ? (
                <ErrorMessage error={errorText(packages.error)} />
              ) : (
                <>
                  <div className="table-scroll applications-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Package</th>
                          <th>Version</th>
                          <th>Install mark</th>
                          <th>Installed size</th>
                          <th>Priority</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.slice(currentPage * 80, currentPage * 80 + 80).map((pkg) => (
                          <tr key={pkg.name}>
                            <td>
                              <button
                                className="file-name package-name"
                                onClick={() => setSelected(pkg)}
                              >
                                <Package size={16} />
                                <span>
                                  <strong>{pkg.name}</strong>
                                  <small title={pkg.description}>{pkg.description}</small>
                                </span>
                              </button>
                            </td>
                            <td className="package-version">{pkg.version}</td>
                            <td>
                              <span className="badge">{pkg.manual ? 'Manual' : 'Automatic'}</span>
                            </td>
                            <td>{bytes(pkg.size)}</td>
                            <td>
                              {pkg.priority || 'Unspecified'}
                              {pkg.protectedReason && (
                                <span className="protected-mark" title={pkg.protectedReason}>
                                  <ShieldCheck size={13} />
                                  Protected
                                </span>
                              )}
                            </td>
                            <td>
                              <button
                                className="danger-text"
                                disabled={busy || !!pkg.protectedReason}
                                title={
                                  pkg.protectedReason ||
                                  'Review affected packages before uninstalling'
                                }
                                onClick={() => prepare('package', pkg.name)}
                              >
                                Uninstall…
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!visible.length && (
                      <Empty title="No matching packages">
                        Adjust the search or package filters.
                      </Empty>
                    )}
                  </div>
                  <div className="application-pagination">
                    <span>
                      {visible.length} matching / {packages.data?.packages.length ?? 0} installed
                      packages
                    </span>
                    <span>
                      Page {currentPage + 1} of {pageCount}
                    </span>
                    <button
                      aria-label="Previous package page"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <button
                      aria-label="Next package page"
                      disabled={currentPage + 1 >= pageCount}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </>
              )}
            </>
          ) : deployments.isPending ? (
            <Loading label="Checking registered deployment folders…" />
          ) : deployments.error ? (
            <ErrorMessage error={errorText(deployments.error)} />
          ) : saved.length ? (
            <div className="deployment-list">
              {saved.map((record) => (
                <DeploymentRow
                  key={record.id}
                  record={record}
                  disabled={busy}
                  edit={() =>
                    setForm({
                      id: record.id,
                      name: record.name,
                      path: record.path,
                      service: record.service || '',
                      notes: record.notes,
                    })
                  }
                  terminal={() => openTerminal(record.path)}
                  forget={() => {
                    void run(async () => {
                      await rpc('applications.forgetDeployment', { sessionId, id: record.id })
                      await deployments.refetch()
                    })
                  }}
                  remove={() => prepare('deployment', record.id)}
                  inspectService={() => {
                    if (record.service)
                      void run(async () =>
                        setService({
                          name: record.service!,
                          detail: await rpc('services.details', {
                            sessionId,
                            name: record.service!,
                          }),
                        }),
                      )
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty title="No registered deployments">
              Add an app’s installation directory and optional systemd service. Uploading a folder
              does not automatically register an app.
            </Empty>
          )}
        </div>
      )}
      {tab === 'processes' && (
        <ServerOutput sessionId={sessionId} module="applications" embedded active={active} />
      )}
      {selected && (
        <Modal
          title={selected.name}
          description={selected.description}
          onClose={() => setSelected(undefined)}
        >
          <dl className="info-list">
            {Object.entries({
              Version: selected.version,
              Architecture: selected.architecture,
              'Installed size': bytes(selected.size),
              'APT mark': selected.manual ? 'Manually marked' : 'Automatic dependency',
              Priority: selected.priority,
              Held: selected.held ? 'Yes' : 'No',
              Protection: selected.protectedReason || 'Not marked as a protected system component',
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            Removal is checked against APT’s dependency plan before any package changes.
          </p>
          <div className="dialog-actions">
            <button
              disabled={busy || !!selected.protectedReason}
              className="danger-text"
              onClick={() => prepare('package', selected.name)}
            >
              Preview uninstall…
            </button>
          </div>
        </Modal>
      )}
      {form && (
        <Modal
          title={form.id ? 'Edit registered deployment' : 'Register a deployed app'}
          description="Save a name, an existing installation directory and an optional systemd service. This registration does not install or run software."
          onClose={() => {
            if (!busy) setForm(undefined)
          }}
        >
          <form
            className="deployment-form"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await rpc('applications.saveDeployment', {
                  sessionId,
                  id: form.id,
                  deployment: {
                    name: form.name,
                    path: form.path,
                    service: form.service?.trim() || undefined,
                    notes: form.notes,
                  },
                })
                setForm(undefined)
                await deployments.refetch()
              })
            }}
          >
            <label>
              App name
              <input
                autoFocus
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Installation directory
              <input
                required
                placeholder="/home/ubuntu/my-app"
                value={form.path}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
              />
            </label>
            <label>
              Systemd service (optional)
              <input
                placeholder="my-app.service"
                value={form.service || ''}
                onChange={(e) => setForm({ ...form, service: e.target.value })}
              />
            </label>
            <label>
              Notes (optional)
              <input
                maxLength={500}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setForm(undefined)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save app
              </button>
            </div>
          </form>
        </Modal>
      )}
      {plan && (
        <Modal
          title={
            plan.kind === 'package' ? `Uninstall ${plan.title}` : `Remove deployment: ${plan.title}`
          }
          description="Review the exact server changes. A native confirmation is required before removal."
          onClose={() => {
            if (!busy) setPlan(undefined)
          }}
          wide
        >
          <div className="removal-summary">
            <Box size={24} />
            <div>
              <strong>{plan.target}</strong>
              <span>
                {plan.itemCount}{' '}
                {plan.kind === 'package'
                  ? plan.itemCount === 1
                    ? 'package'
                    : 'packages'
                  : 'filesystem entries'}{' '}
                · {bytes(plan.totalBytes)}
              </span>
            </div>
            <span className="badge">
              {expired
                ? 'Preview expired — close and preview again'
                : 'Preview expires in 2 minutes'}
            </span>
          </div>
          {plan.affected.length > 0 && (
            <div className="removal-packages">
              <table>
                <thead>
                  <tr>
                    <th>APT will remove</th>
                    <th>Version</th>
                    <th>Installed size</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.affected.map((pkg) => (
                    <tr key={pkg.name}>
                      <td>{pkg.name}</td>
                      <td>{pkg.version}</td>
                      <td>{bytes(pkg.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan.service && (
            <p className="muted">
              Linked service: <code>{plan.service}</code>
            </p>
          )}
          {plan.warnings.map((warning) => (
            <p key={warning} className="removal-warning">
              <Info size={15} />
              {warning}
            </p>
          ))}
          {plan.blocked.length > 0 && (
            <ErrorMessage error={`Removal blocked: ${plan.blocked.join(' ')}`} />
          )}
          {(plan.kind === 'package' || plan.service) && plan.uid !== 0 && (
            <label className="elevation-field">
              Authorization
              <select
                aria-label="Removal authorization"
                disabled={busy}
                value={elevation}
                onChange={(event) => setElevation(event.target.value as Elevation)}
              >
                <option value="none">Current SSH account — no elevation</option>
                <option value="sudo">Use existing sudo authorization for this action</option>
              </select>
              <small className="muted">
                Sudo uses -n. Server-granted noninteractive permission or an existing ticket is
                required; no password is saved or requested.
              </small>
            </label>
          )}
          {busy && (
            <div className="application-operation" role="status">
              <Loading label={operation?.message || 'Revalidating removal…'} />
              <p>Keep the application open. Once package changes begin, do not interrupt dpkg.</p>
            </div>
          )}
          <div className="dialog-actions">
            <button disabled={busy} onClick={() => setPlan(undefined)}>
              Cancel
            </button>
            <button
              className="danger-action"
              disabled={
                busy ||
                !!plan.blocked.length ||
                (plan.kind === 'package' && plan.uid !== 0 && elevation === 'none') ||
                expired
              }
              onClick={execute}
            >
              Continue to final confirmation…
            </button>
          </div>
        </Modal>
      )}
      {service && (
        <Modal
          title={service.name}
          description="Actual systemd service properties from this server."
          onClose={() => setService(undefined)}
        >
          <pre className="output-pane">{service.detail}</pre>
        </Modal>
      )}
    </div>
  )
}
function DeploymentRow({
  record,
  disabled,
  edit,
  terminal,
  forget,
  remove,
  inspectService,
}: {
  record: DeploymentStatus
  disabled: boolean
  edit: () => void
  terminal: () => void
  forget: () => void
  remove: () => void
  inspectService: () => void
}) {
  return (
    <div className="deployment-row">
      <span className="quick-icon">
        <Box size={21} />
      </span>
      <div className="deployment-info">
        <strong>
          {record.name}
          <span className={`badge ${record.state === 'present' ? 'live' : ''}`}>
            {record.state === 'present' ? 'Folder available' : record.state}
          </span>
        </strong>
        <code>{record.path}</code>
        {record.service && (
          <button className="text-button service-link" onClick={inspectService}>
            {record.service}
          </button>
        )}
        {record.notes && <p>{record.notes}</p>}
        {record.reason && <small className="danger-text">{record.reason}</small>}
      </div>
      <div className="deployment-actions">
        <button disabled={disabled || record.state !== 'present'} onClick={terminal}>
          <Terminal size={14} />
          Terminal
        </button>
        <button disabled={disabled} onClick={edit}>
          Edit
        </button>
        <button disabled={disabled} onClick={forget}>
          Remove from list
        </button>
        <button
          className="danger-text"
          disabled={disabled || record.state !== 'present'}
          onClick={remove}
        >
          <Trash2 size={14} />
          Remove files…
        </button>
      </div>
    </div>
  )
}
