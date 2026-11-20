import type { Input, Route } from '../../../shared/schemas'
import type { Outputs } from '../../../shared/contracts/api'
import type { AppErrorData } from '../../../domain/errors/app-error'
export class RequestError extends Error {
  constructor(public detail: AppErrorData) {
    super(detail.message)
  }
}
export async function rpc<K extends Route>(route: K, input: Input<K>): Promise<Outputs[K]> {
  if (!window.vps)
    throw new Error(
      'Open VPS Manager using the desktop application. The secure desktop bridge is unavailable.',
    )
  const result = await window.vps.invoke(route, input)
  if (!result.ok) throw new RequestError(result.error)
  return result.value
}
export function errorText(error: unknown): string {
  return error instanceof RequestError
    ? `${error.message} ${error.detail.suggestion}`
    : error instanceof Error
      ? error.message
      : 'The operation could not be completed.'
}
