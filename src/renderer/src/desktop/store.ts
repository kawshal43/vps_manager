import { create } from 'zustand'
import type { ServerSession } from '../../../domain/connection/types'
import {
  defaultWorkspace,
  fitBounds,
  type AppId,
  type Bounds,
  type WorkspaceLayout,
} from '../../../shared/workspace'
import { apps } from './registry'

export interface DesktopWindow {
  id: string
  app: AppId | 'editor'
  sessionId?: string
  scope: string
  path?: string
  bounds: Bounds
  mode: 'normal' | 'maximized' | 'minimized'
  restoreMode: 'normal' | 'maximized'
  dirty: boolean
  started: boolean
  order: number
}
export const serverScope = (s: ServerSession) =>
  JSON.stringify([s.profile.host.toLowerCase(), s.profile.port, s.profile.username])
export const windowId = (app: AppId | 'editor', session?: ServerSession, path?: string) =>
  app === 'settings' ? 'global:settings' : `${session?.id}:${app}:${path || ''}`

interface DesktopState {
  windows: DesktopWindow[]
  activeWindow?: string
  layout: WorkspaceLayout
  ready: boolean
  warning?: string
  hydrate: (layout: WorkspaceLayout, warning?: string) => void
  attach: (session: ServerSession) => void
  open: (app: AppId | 'editor', session?: ServerSession, path?: string) => string
  focus: (id: string) => void
  minimize: (id: string) => void
  maximize: (id: string) => void
  move: (id: string, bounds: Bounds) => void
  close: (id: string) => void
  dirty: (id: string, value: boolean) => void
  pin: (app: AppId) => void
}

function persistWindows(layout: WorkspaceLayout, windows: DesktopWindow[]): WorkspaceLayout {
  const saved = [...layout.windows]
  for (const w of windows) {
    if (w.app === 'editor') continue
    const value = {
      scope: w.scope,
      app: w.app,
      bounds: w.bounds,
      mode: w.mode,
      restoreMode: w.restoreMode,
      open: true,
    }
    const index = saved.findIndex((p) => p.scope === w.scope && p.app === w.app)
    if (index < 0) saved.push(value)
    else saved[index] = value
  }
  return { ...layout, windows: saved.slice(-256) }
}
export const useDesktop = create<DesktopState>((set, get) => ({
  windows: [],
  layout: defaultWorkspace(),
  ready: false,
  hydrate: (layout, warning) => set({ layout, warning, ready: true }),
  attach: (session) => {
    const state = get()
    if (!state.ready || state.windows.some((w) => w.sessionId === session.id)) return
    const scope = serverScope(session)
    const restored = state.layout.windows
      .filter((p) => p.open && (p.scope === scope || p.scope === 'global'))
      .filter((p) => !state.windows.some((w) => w.id === windowId(p.app, session)))
      .map((p): DesktopWindow => ({
        ...p,
        id: windowId(p.app, session),
        sessionId: p.app === 'settings' ? undefined : session.id,
        mode: p.app === 'terminal' ? 'minimized' : p.mode,
        restoreMode: p.mode === 'maximized' ? 'maximized' : p.restoreMode,
        dirty: false,
        started: p.app !== 'terminal',
        order:
          Math.max(0, ...state.windows.map((v) => v.order)) + state.layout.windows.indexOf(p) + 1,
      }))
    set({
      windows: [...state.windows, ...restored],
      activeWindow: restored.findLast((w) => w.mode !== 'minimized')?.id ?? state.activeWindow,
    })
  },
  open: (app, session, path) => {
    const state = get()
    const id = windowId(app, session, path)
    const existing = state.windows.find((w) => w.id === id)
    if (existing) {
      state.focus(id)
      return id
    }
    const scope = app === 'settings' ? 'global' : serverScope(session!)
    const saved = state.layout.windows.find((w) => w.scope === scope && w.app === app)
    const size = app === 'editor' ? { width: 860, height: 580 } : apps[app]
    const offset = (state.windows.filter((w) => w.sessionId === session?.id).length % 5) * 26
    const bounds = fitBounds(
      saved?.bounds ?? { x: 140 + offset, y: 45 + offset, width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight - 104 },
    )
    const w: DesktopWindow = {
      id,
      app,
      sessionId: app === 'settings' ? undefined : session?.id,
      scope,
      path,
      bounds,
      mode: saved?.mode === 'maximized' ? 'maximized' : 'normal',
      restoreMode: 'normal',
      dirty: false,
      started: true,
      order: Math.max(0, ...state.windows.map((v) => v.order)) + 1,
    }
    const windows = [...state.windows, w]
    set({ windows, activeWindow: id, layout: persistWindows(state.layout, windows) })
    return id
  },
  focus: (id) =>
    set((s) => {
      const w = s.windows.find((w) => w.id === id)
      if (!w) return {}
      // Keep mounted DOM nodes in place: moving a focused subtree interrupts clicks and resets scroll.
      const order = Math.max(0, ...s.windows.map((v) => v.order)) + 1
      const windows = s.windows.map((v) =>
        v.id === id
          ? { ...v, mode: v.mode === 'minimized' ? v.restoreMode : v.mode, started: true, order }
          : v,
      )
      return { windows, activeWindow: id, layout: persistWindows(s.layout, windows) }
    }),
  minimize: (id) =>
    set((s) => {
      const windows = s.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              restoreMode: w.mode === 'maximized' ? ('maximized' as const) : ('normal' as const),
              mode: 'minimized' as const,
            }
          : w,
      )
      return {
        windows,
        activeWindow: s.activeWindow === id ? undefined : s.activeWindow,
        layout: persistWindows(s.layout, windows),
      }
    }),
  maximize: (id) =>
    set((s) => {
      const windows = s.windows.map((w) =>
        w.id === id
          ? { ...w, mode: w.mode === 'maximized' ? ('normal' as const) : ('maximized' as const) }
          : w,
      )
      return { windows, layout: persistWindows(s.layout, windows) }
    }),
  move: (id, bounds) =>
    set((s) => {
      const windows = s.windows.map((w) => (w.id === id ? { ...w, bounds } : w))
      return { windows, layout: persistWindows(s.layout, windows) }
    }),
  close: (id) =>
    set((s) => {
      const w = s.windows.find((w) => w.id === id)
      const windows = s.windows.filter((w) => w.id !== id)
      const layout = persistWindows(s.layout, windows)
      if (w)
        layout.windows = layout.windows.map((p) =>
          p.scope === w.scope && p.app === w.app ? { ...p, open: false } : p,
        )
      return { windows, activeWindow: s.activeWindow === id ? undefined : s.activeWindow, layout }
    }),
  dirty: (id, value) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, dirty: value } : w)) })),
  pin: (app) =>
    set((s) => ({
      layout: {
        ...s.layout,
        pinned: s.layout.pinned.includes(app)
          ? s.layout.pinned.filter((v) => v !== app)
          : [...s.layout.pinned, app],
      },
    })),
}))
