import type { ReactNode, ButtonHTMLAttributes } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, AlertCircle, LoaderCircle, Server } from 'lucide-react'
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Server size={21} />
      </span>
      {!compact && (
        <span>
          VPS<span className="brand-light"> Manager</span>
        </span>
      )}
    </div>
  )
}
export function IconButton({
  title,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button type="button" className="icon-button" title={title} aria-label={title} {...props}>
      {children}
    </button>
  )
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? 'modal-wide' : ''}`}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            onClose()
          }}
        >
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <IconButton title="Close dialog" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <Dialog.Description className={description ? 'muted' : 'sr-only'}>
            {description || title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
export function Loading({ label = 'Loading from server…' }: { label?: string }) {
  return (
    <div className="loading">
      <LoaderCircle size={20} className="spin" />
      <span>{label}</span>
    </div>
  )
}
export function ErrorMessage({ error }: { error: string }) {
  return (
    <div className="inline-error" role="alert">
      <AlertCircle size={18} />
      <span>{error}</span>
    </div>
  )
}
export function PageHeading({
  eyebrow = 'SERVER WORKSPACE',
  title,
  description,
  children,
}: {
  eyebrow?: string
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  )
}
export function bytes(value: number) {
  if (!value) return '0 B'
  const n = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** n).toFixed(n ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][n]}`
}
export function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleString()
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Server size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}
