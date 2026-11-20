import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, RotateCcw, X } from 'lucide-react'
import { useApp } from '../../app/store'
import { useAction } from '../../hooks/use-action'
import { rpc } from '../../app/api'
import { bytes, Empty, IconButton, PageHeading } from '../../components/ui'
export function Transfers({ sessionId }: { sessionId: string }) {
  const jobs = useApp((s) => s.jobs)
    .filter((j) => j.sessionId === sessionId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const { run } = useAction()
  const active = jobs.filter((j) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status))
  const total = jobs.reduce((n, j) => n + j.size, 0)
  const done = jobs.reduce((n, j) => n + j.transferred, 0)
  return (
    <div className="page">
      <PageHeading
        title="Transfers"
        description="Files move directly between this computer and your server."
      >
        <span className="badge">{active.length} active</span>
        <button
          disabled={!active.length}
          onClick={() => {
            void run(async () => {
              for (const j of active) await rpc('transfers.cancel', { id: j.id })
            })
          }}
        >
          <X size={15} />
          Cancel active
        </button>
      </PageHeading>
      {jobs.length > 0 && (
        <div className="batch-progress">
          <strong>
            {bytes(done)} / {bytes(total)}
          </strong>
          <span>
            {jobs.filter((j) => j.status === 'COMPLETED').length} of {jobs.length} files completed
          </span>
          <progress max={total || 1} value={done} />
        </div>
      )}
      {!jobs.length ? (
        <Empty title="No transfers yet">
          Upload or download files from the file explorer. Progress appears here.
        </Empty>
      ) : (
        <div className="panel transfer-list">
          {jobs.map((j) => (
            <div key={j.id} className="transfer-row">
              <span className="transfer-direction">
                {j.direction === 'upload' ? (
                  <ArrowUpFromLine size={20} />
                ) : (
                  <ArrowDownToLine size={20} />
                )}
              </span>
              <div className="transfer-detail">
                <strong>{j.remotePath.split('/').at(-1)}</strong>
                <span title={j.remotePath}>{j.remotePath}</span>
                <progress value={j.transferred} max={j.size || 1} />
                <small className={j.status === 'FAILED' ? 'danger-text' : ''}>
                  {j.error ||
                    `${bytes(j.transferred)} / ${bytes(j.size)}${j.status === 'TRANSFERRING' ? ` · ${bytes(j.speed)}/s · ${Math.ceil((j.size - j.transferred) / Math.max(1, j.speed))}s remaining` : ''}`}
                </small>
              </div>
              <span className={`badge ${j.status === 'COMPLETED' ? 'live' : ''}`}>
                {j.status.toLowerCase()}
              </span>
              {['FAILED', 'CANCELLED'].includes(j.status) ? (
                <IconButton
                  title="Retry transfer"
                  onClick={() => {
                    void run(() => rpc('transfers.retry', { id: j.id }))
                  }}
                >
                  <RotateCcw size={16} />
                </IconButton>
              ) : j.status === 'COMPLETED' ? (
                j.direction === 'download' && (
                  <IconButton
                    title="Show downloaded file"
                    onClick={() => {
                      void run(() => rpc('transfers.reveal', { id: j.id }))
                    }}
                  >
                    <FolderOpen size={16} />
                  </IconButton>
                )
              ) : (
                <IconButton
                  title="Cancel transfer"
                  onClick={() => {
                    void run(() => rpc('transfers.cancel', { id: j.id }))
                  }}
                >
                  <X size={16} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
