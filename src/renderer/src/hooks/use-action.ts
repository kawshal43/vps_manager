import { useState } from 'react'
import { errorText } from '../app/api'
import { useApp } from '../app/store'
export function useAction() {
  const [busy, setBusy] = useState(false)
  const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    useApp.getState().set({ error: undefined })
    try {
      return await action()
    } catch (error) {
      useApp.getState().set({ error: errorText(error) })
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}
