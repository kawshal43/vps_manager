import { Component, useEffect, useMemo, useRef, type ReactNode, type PointerEvent } from 'react'
import { Minus, Square, Copy, X, RotateCcw } from 'lucide-react'
import { fitBounds, type Bounds } from '../../../shared/workspace'
import { IconButton } from '../components/ui'
import { useDesktop, type DesktopWindow } from './store'
import { apps } from './registry'

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div className="window-failure">
        <h2>This view was interrupted</h2>
        <p>Check any in-flight server operation before retrying.</p>
        <button onClick={() => this.setState({ failed: false })}>
          <RotateCcw size={15} /> Reopen view
        </button>
      </div>
    ) : (
      this.props.children
    )
  }
}
export function WindowFrame({
  window: w,
  area,
  visible,
  focused,
  index,
  serverName,
  onClose,
  children,
}: {
  window: DesktopWindow
  area: { width: number; height: number }
  visible: boolean
  focused: boolean
  index: number
  serverName?: string
  onClose: () => void
  children: ReactNode
}) {
  const element = useRef<HTMLElement>(null)
  const pointerFocus = useRef(false)
  const gesture = useRef<
    { x: number; y: number; bounds: Bounds; edge: string; next: Bounds } | undefined
  >(undefined)
  const title = w.app === 'editor' ? w.path!.split('/').at(-1)! : apps[w.app].name
  const bounds = useMemo(() => fitBounds(w.bounds, area), [w.bounds, area])
  useEffect(() => {
    if (focused && pointerFocus.current) {
      pointerFocus.current = false
      return
    }
    if (focused && element.current && !element.current.contains(document.activeElement))
      element.current.querySelector<HTMLElement>('.window-titlebar')?.focus({ preventScroll: true })
  }, [focused])
  useEffect(() => {
    if (
      w.bounds.x !== bounds.x ||
      w.bounds.y !== bounds.y ||
      w.bounds.width !== bounds.width ||
      w.bounds.height !== bounds.height
    )
      useDesktop.getState().move(w.id, bounds)
  }, [w.id, w.bounds, bounds])
  const start = (e: PointerEvent<HTMLElement>) => {
    const edge = e.currentTarget.dataset.edge || ''
    if (e.button !== 0 || w.mode !== 'normal' || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    gesture.current = { x: e.clientX, y: e.clientY, bounds, edge, next: bounds }
    e.currentTarget.setPointerCapture(e.pointerId)
    element.current?.classList.add('window-moving')
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || !element.current) return
    const dx = e.clientX - g.x,
      dy = e.clientY - g.y
    const next = { ...g.bounds }
    if (!g.edge) {
      next.x += dx
      next.y += dy
    } else {
      if (g.edge.includes('e')) next.width += dx
      if (g.edge.includes('s')) next.height += dy
      if (g.edge.includes('w')) {
        next.width -= dx
        next.x += dx
      }
      if (g.edge.includes('n')) {
        next.height -= dy
        next.y += dy
      }
      if (next.width < 560) {
        next.width = 560
        if (g.edge.includes('w')) next.x = g.bounds.x + g.bounds.width - 560
      }
      if (next.height < 350) {
        next.height = 350
        if (g.edge.includes('n')) next.y = g.bounds.y + g.bounds.height - 350
      }
    }
    g.next = fitBounds(next, area)
    Object.assign(element.current.style, {
      left: `${g.next.x}px`,
      top: `${g.next.y}px`,
      width: `${g.next.width}px`,
      height: `${g.next.height}px`,
    })
  }
  const finish = () => {
    const g = gesture.current
    gesture.current = undefined
    element.current?.classList.remove('window-moving')
    if (g) useDesktop.getState().move(w.id, g.next)
  }
  return (
    <section
      ref={element}
      className={`os-window ${focused ? 'is-focused' : ''} ${w.mode === 'maximized' ? 'is-maximized' : ''}`}
      data-window-id={w.id}
      data-app={w.app}
      role="region"
      aria-label={`${title} window`}
      hidden={!visible || w.mode === 'minimized'}
      style={{
        left: w.mode === 'maximized' ? 8 : bounds.x,
        top: w.mode === 'maximized' ? 8 : bounds.y,
        width: w.mode === 'maximized' ? area.width - 16 : bounds.width,
        height: w.mode === 'maximized' ? area.height - 16 : bounds.height,
        zIndex: index + 1,
      }}
      onPointerDownCapture={() => {
        if (!focused) {
          pointerFocus.current = true
          useDesktop.getState().focus(w.id)
        }
      }}
      onFocusCapture={() => {
        if (!focused) useDesktop.getState().focus(w.id)
      }}
    >
      <header
        className="window-titlebar"
        tabIndex={0}
        aria-label={`Move ${title} window`}
        title="Ctrl + Arrow keys to move; Ctrl + Shift + Arrow keys to resize"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) useDesktop.getState().maximize(w.id)
        }}
        onKeyDown={(e) => {
          if (
            e.target !== e.currentTarget ||
            !e.ctrlKey ||
            !e.key.startsWith('Arrow') ||
            w.mode !== 'normal'
          )
            return
          e.preventDefault()
          const dx = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0
          const dy = e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0
          useDesktop
            .getState()
            .move(
              w.id,
              fitBounds(
                e.shiftKey
                  ? { ...bounds, width: bounds.width + dx, height: bounds.height + dy }
                  : { ...bounds, x: bounds.x + dx, y: bounds.y + dy },
                area,
              ),
            )
        }}
      >
        <span className={`window-app-dot ${w.app === 'editor' ? 'blue' : apps[w.app].color}`} />
        <strong>
          {w.dirty ? '● ' : ''}
          {title}
        </strong>
        <span className="window-server-name">{serverName || 'Preferences'}</span>
        <div className="window-controls">
          <IconButton
            title={`Minimize ${title}`}
            onClick={() => useDesktop.getState().minimize(w.id)}
          >
            <Minus size={15} />
          </IconButton>
          <IconButton
            title={`${w.mode === 'maximized' ? 'Restore' : 'Maximize'} ${title}`}
            onClick={() => useDesktop.getState().maximize(w.id)}
          >
            {w.mode === 'maximized' ? <Copy size={13} /> : <Square size={13} />}
          </IconButton>
          <IconButton title={`Close ${title}`} onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
      </header>
      <div className="window-content">
        <AppBoundary>{children}</AppBoundary>
      </div>
      {w.mode === 'normal' &&
        ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
          <div
            key={edge}
            className={`window-resize resize-${edge}`}
            aria-hidden="true"
            data-edge={edge}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
          />
        ))}
    </section>
  )
}
