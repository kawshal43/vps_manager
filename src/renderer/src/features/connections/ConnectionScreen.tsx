import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  ChevronRight,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { ServerProfile } from '../../../../domain/connection/types'
import { profileSchema } from '../../../../shared/schemas'
import { rpc } from '../../app/api'
import { useApp } from '../../app/store'
import { useAction } from '../../hooks/use-action'
import { Brand, IconButton, Loading, Modal } from '../../components/ui'
import { developerCredits } from '../../../../shared/product'
const fresh = (): ServerProfile => ({
  id: crypto.randomUUID(),
  displayName: '',
  host: '',
  port: 22,
  username: 'ubuntu',
  authenticationMethod: 'password',
})
export function ConnectionScreen({ onClose }: { onClose?: () => void }) {
  const client = useQueryClient()
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: () => rpc('app.bootstrap', {}) })
  const [profile, setProfile] = useState<ServerProfile>(fresh)
  const [restored, setRestored] = useState(false)
  const [secret, setSecret] = useState('')
  const [key, setKey] = useState<{ token: string; name: string } | null>(null)
  const [rememberServer, setRememberServer] = useState(true)
  const [rememberCredentials, setRememberCredentials] = useState(false)
  if (bootstrap.data && !restored) {
    setRestored(true)
    const last = bootstrap.data.profiles.find(
      (p) => p.id === bootstrap.data.preferences.lastProfileId,
    )
    if (last) {
      setProfile(
        profileSchema.parse(
          Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'hasCredential')),
        ),
      )
      setRememberCredentials(!!last.hasCredential)
    }
  }
  const [validation, setValidation] = useState<string>()
  const { busy, run } = useAction()
  const sessions = useApp((s) => s.sessions)
  const connecting = [...sessions]
    .reverse()
    .find(
      (s) =>
        ![
          'CONNECTED',
          'DISCONNECTED',
          'CONNECTION_FAILED',
          'AUTHENTICATION_FAILED',
          'CONNECTION_LOST',
        ].includes(s.state),
    )
  const update = (patch: Partial<ServerProfile>) => {
    setProfile((p) => ({ ...p, ...patch }))
    setValidation(undefined)
  }
  const select = (p: ServerProfile) => {
    setProfile(
      profileSchema.parse(
        Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'hasCredential')),
      ),
    )
    setSecret('')
    setKey(null)
    setRememberCredentials(!!p.hasCredential)
    setValidation(undefined)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = profileSchema.safeParse(profile)
    if (!parsed.success) {
      setValidation(parsed.error.issues[0].message)
      return
    }
    void run(async () => {
      const session = await rpc('connection.connect', {
        profile: parsed.data,
        secret: secret || undefined,
        keyToken: key?.token,
        rememberServer,
        rememberCredentials,
      })
      setSecret('')
      useApp.getState().updateSession(session)
      useApp.getState().set({ activeId: session.id })
      await client.invalidateQueries({ queryKey: ['bootstrap'] })
      onClose?.()
    })
  }
  const savedCredential = bootstrap.data?.profiles.find((p) => p.id === profile.id)?.hasCredential
  return (
    <div className="connection-screen">
      <aside className="connection-aside">
        <Brand />
        <div className="connection-intro">
          <div className="eyebrow">YOUR INFRASTRUCTURE. WITHIN REACH.</div>
          <h1>
            A better view
            <br />
            of your server.
          </h1>
          <p>
            Files, terminals, and the tools you need.
            <br />
            One secure connection to Ubuntu.
          </p>
        </div>
        <div className="saved-header">
          <span>SAVED SERVERS</span>
          <IconButton
            title="New connection"
            onClick={() => {
              setProfile(fresh())
              setSecret('')
              setKey(null)
            }}
          >
            <Plus size={16} />
          </IconButton>
        </div>
        <div className="saved-list">
          {bootstrap.data?.profiles.map((p) => (
            <div className={`saved-server ${profile.id === p.id ? 'active' : ''}`} key={p.id}>
              <button onClick={() => select(p)}>
                <span className="server-icon">
                  <Server size={18} />
                </span>
                <span>
                  <strong>{p.displayName || p.host}</strong>
                  <small>
                    {p.username}@{p.host}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
              <IconButton
                title={`Remove ${p.displayName || p.host}`}
                onClick={() => {
                  if (window.confirm('Remove this saved profile and its remembered credentials?'))
                    void run(async () => {
                      await rpc('profiles.remove', { id: p.id })
                      await client.invalidateQueries({ queryKey: ['bootstrap'] })
                    })
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
          {!bootstrap.data?.profiles.length && (
            <div className="saved-empty">
              Your saved servers will appear here.
              <br />
              Credentials stay on this computer.
            </div>
          )}
        </div>
        <div className="connection-security">
          <ShieldCheck size={19} />
          <div>
            <strong>Direct. Private. Encrypted.</strong>
            <span>SSH transport · No server agent · No account</span>
          </div>
        </div>
        <div className="aside-version">
          VPS MANAGER <span>DESKTOP / {bootstrap.data?.version ?? '…'}</span>
        </div>
      </aside>
      <main className="connection-main">
        {onClose && (
          <button className="text-button close-connection" onClick={onClose}>
            Back to workspace
          </button>
        )}
        <div className="connect-form-wrap">
          <div className="connect-badge">
            <LockKeyhole size={21} />
          </div>
          <div className="eyebrow">LET’S GET CONNECTED</div>
          <h2>Connect to your server</h2>
          <p className="connect-description">
            Enter your SSH details to open your Ubuntu workspace.
          </p>
          <form onSubmit={submit} className="connect-form">
            <fieldset disabled={busy}>
              <label>
                Server name <span className="optional">optional</span>
                <input
                  placeholder="e.g. Production · Singapore"
                  value={profile.displayName}
                  onChange={(e) => update({ displayName: e.target.value })}
                />
              </label>
              <div className="form-row host-row">
                <label>
                  Server address
                  <input
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="IP address or hostname"
                    value={profile.host}
                    onChange={(e) => update({ host: e.target.value })}
                  />
                </label>
                <label>
                  SSH port
                  <input
                    required
                    type="number"
                    min="1"
                    max="65535"
                    value={profile.port}
                    onChange={(e) => update({ port: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label>
                Username
                <input
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                  value={profile.username}
                  onChange={(e) => update({ username: e.target.value })}
                />
              </label>
              <label>Authentication</label>
              <div className="segmented">
                <button
                  type="button"
                  className={profile.authenticationMethod === 'password' ? 'selected' : ''}
                  onClick={() => {
                    update({ authenticationMethod: 'password' })
                    setSecret('')
                  }}
                >
                  <LockKeyhole size={15} />
                  Password
                </button>
                <button
                  type="button"
                  className={profile.authenticationMethod === 'key' ? 'selected' : ''}
                  onClick={() => {
                    update({ authenticationMethod: 'key' })
                    setSecret('')
                  }}
                >
                  <KeyRound size={15} />
                  SSH private key
                </button>
              </div>
              {profile.authenticationMethod === 'key' && (
                <button
                  type="button"
                  className="key-picker"
                  onClick={() => {
                    void run(async () => setKey(await rpc('connection.pickKey', {})))
                  }}
                >
                  <KeyRound size={16} />
                  {key?.name ||
                    (profile.privateKeyReference
                      ? 'Saved private key selected'
                      : 'Choose a private key…')}
                </button>
              )}
              <label>
                {profile.authenticationMethod === 'key' ? 'Key passphrase' : 'Password'}
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    savedCredential
                      ? 'Leave blank to use saved credential'
                      : profile.authenticationMethod === 'key'
                        ? 'If your key is encrypted'
                        : 'Enter your SSH password'
                  }
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <div className="remember-options">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={rememberServer}
                    onChange={(e) => {
                      setRememberServer(e.target.checked)
                      if (!e.target.checked) setRememberCredentials(false)
                    }}
                  />
                  Save server profile
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={!rememberServer || !bootstrap.data?.secureStorage}
                    checked={rememberCredentials}
                    onChange={(e) => setRememberCredentials(e.target.checked)}
                  />
                  Remember credentials <span className="optional">OS encrypted</span>
                </label>
              </div>
            </fieldset>
            {validation && (
              <div className="inline-error" role="alert">
                {validation}
              </div>
            )}
            <button
              className="primary connect-submit"
              disabled={busy || !bootstrap.data}
              type="submit"
            >
              {busy ? (
                <Loading
                  label={connecting?.state.replaceAll('_', ' ').toLowerCase() || 'Connecting…'}
                />
              ) : (
                <>
                  Connect to server
                  <ArrowRight size={18} />
                </>
              )}
            </button>
            {busy && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  void rpc('connection.cancel', {})
                }}
              >
                Cancel connection
              </button>
            )}
          </form>
          <div className="fingerprint-note">
            <Fingerprint size={17} />
            <span>You’ll verify the server’s SSH fingerprint before authentication.</span>
          </div>
          <div className="connect-features">
            <span>
              <Check size={13} />
              Ubuntu Server
            </span>
            <span>
              <Check size={13} />
              Password & key authentication
            </span>
            <span>
              <Check size={13} />
              IPv4 & IPv6
            </span>
          </div>
        </div>
        <div className="connection-footer">
          Your servers. Your permissions. Your control.
          <span className="developer-credit">
            {developerCredits.company} · {developerCredits.developers.join(' · ')}
          </span>
        </div>
      </main>
    </div>
  )
}
export function HostKeyDialog() {
  const challenge = useApp((s) => s.challenge)
  const { busy, run } = useAction()
  if (!challenge) return null
  const answer = (accept: boolean) => {
    void run(async () => {
      await rpc('connection.trust', { id: challenge.id, accept })
      useApp.getState().set({ challenge: undefined })
    })
  }
  return (
    <Modal
      title="Verify server identity"
      description="Compare this fingerprint with a trusted source such as your server provider’s console before accepting."
      onClose={() => answer(false)}
    >
      <div className="host-key">
        <Fingerprint size={30} />
        <dl>
          <dt>Server</dt>
          <dd>
            {challenge.host}:{challenge.port}
          </dd>
          <dt>Key type</dt>
          <dd>{challenge.keyType}</dd>
          <dt>SHA-256 fingerprint</dt>
          <dd className="fingerprint">{challenge.fingerprint}</dd>
        </dl>
      </div>
      <p className="muted">
        Accepting saves this key on your computer. Unexpected future key changes will block the
        connection.
      </p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => answer(false)}>
          Reject
        </button>
        <button disabled={busy} className="primary" onClick={() => answer(true)}>
          Trust and connect
        </button>
      </div>
    </Modal>
  )
}
