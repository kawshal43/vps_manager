import { useQuery } from '@tanstack/react-query'
import { Fingerprint, ShieldCheck } from 'lucide-react'
import { rpc } from '../../app/api'
import { useApp } from '../../app/store'
import { useAction } from '../../hooks/use-action'
import { PageHeading } from '../../components/ui'
import type { Preferences } from '../../../../domain/connection/types'
import { developerCredits } from '../../../../shared/product'
export function Settings() {
  const preferences = useApp((s) => s.preferences)
  const { run, busy } = useAction()
  const q = useQuery({ queryKey: ['bootstrap'], queryFn: () => rpc('app.bootstrap', {}) })
  const save = (patch: Partial<Preferences>) => {
    void run(async () => {
      const result = await rpc('app.preferences', { ...preferences, ...patch })
      useApp.getState().set({ preferences: result })
    })
  }
  return (
    <div className="page settings-page">
      <PageHeading title="Settings" description="Preferences and security on this computer." />
      <section className="panel" aria-labelledby="about-vps-manager">
        <div className="panel-heading">
          <h3 id="about-vps-manager">About VPS Manager</h3>
          <span className="badge">Version {q.data?.version ?? '…'}</span>
        </div>
        <div className="setting">
          <div>
            <strong>{developerCredits.company}</strong>
            <p>Developed by {developerCredits.developers.join(', ')}.</p>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h3>Workspace</h3>
        </div>
        <div className="setting">
          <div>
            <strong>Appearance</strong>
            <p>Choose the desktop workspace theme.</p>
          </div>
          <select
            aria-label="Appearance"
            disabled={busy}
            value={preferences.theme}
            onChange={(e) => save({ theme: e.target.value as Preferences['theme'] })}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>Concurrent transfers</strong>
            <p>Maximum files moving at once.</p>
          </div>
          <select
            disabled={busy}
            aria-label="Concurrent transfers"
            value={preferences.concurrency}
            onChange={(e) => save({ concurrency: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>Monitoring interval</strong>
            <p>Polling pauses when the monitoring view is inactive.</p>
          </div>
          <select
            disabled={busy}
            aria-label="Monitoring interval"
            value={preferences.monitoringInterval}
            onChange={(e) => save({ monitoringInterval: Number(e.target.value) })}
          >
            {[3, 5, 10, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h3>
            <Fingerprint size={17} />
            Trusted host keys
          </h3>
          <span className="badge">SHA-256</span>
        </div>
        {q.data?.trustedHosts.map((h) => (
          <div key={`${h.host}:${h.port}:${h.acceptedAt}`} className="trusted-host">
            <strong>
              {h.host}:{h.port} <span className="muted">{h.keyType}</span>
            </strong>
            <code>{h.fingerprint}</code>
            <small className="muted">Verified {new Date(h.acceptedAt).toLocaleString()}</small>
          </div>
        ))}
        {!q.data?.trustedHosts.length && (
          <p className="panel-padding muted">No server identities have been trusted yet.</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h3>
            <ShieldCheck size={17} />
            Credentials & diagnostics
          </h3>
        </div>
        {q.data?.profiles
          .filter((p) => p.hasCredential)
          .map((p) => (
            <div className="setting" key={p.id}>
              <strong>{p.displayName || p.host}</strong>
              <button
                onClick={() => {
                  void run(async () => {
                    await rpc('profiles.forgetCredentials', { id: p.id })
                    await q.refetch()
                  })
                }}
              >
                Forget saved credential
              </button>
            </div>
          ))}
        <div className="setting">
          <div>
            <strong>Local diagnostics</strong>
            <p>Operation names and error codes only. No credentials or terminal output.</p>
          </div>
          <button
            onClick={() => {
              void run(() => rpc('app.diagnostics', {}))
            }}
          >
            Open log folder
          </button>
        </div>
      </section>
    </div>
  )
}
