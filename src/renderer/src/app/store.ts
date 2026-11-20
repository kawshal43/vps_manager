import { create } from 'zustand'
import type { HostChallenge, Preferences, ServerSession } from '../../../domain/connection/types'
import { defaultPreferences } from '../../../domain/connection/types'
import type { TransferJob } from '../../../domain/transfers/types'
export type Module =
  | 'overview'
  | 'files'
  | 'transfers'
  | 'terminal'
  | 'applications'
  | 'websites'
  | 'services'
  | 'monitoring'
  | 'logs'
  | 'settings'
interface State {
  sessions: ServerSession[]
  activeId?: string
  challenge?: HostChallenge
  jobs: TransferJob[]
  preferences: Preferences
  error?: string
  notice?: string
  set: (state: Partial<Omit<State, 'set' | 'updateSession' | 'updateJob'>>) => void
  updateSession: (session: ServerSession) => void
  updateJob: (job: TransferJob) => void
}
export const useApp = create<State>((set) => ({
  sessions: [],
  jobs: [],
  preferences: defaultPreferences,
  set: (state) => set(state),
  updateSession: (session) =>
    set((state) => ({ sessions: [...state.sessions.filter((s) => s.id !== session.id), session] })),
  updateJob: (job) =>
    set((state) => ({ jobs: [...state.jobs.filter((j) => j.id !== job.id), job] })),
}))
