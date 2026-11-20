export type TransferStatus =
  | 'QUEUED'
  | 'VALIDATING'
  | 'PREPARING'
  | 'TRANSFERRING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
export interface TransferJob {
  id: string
  sessionId: string
  batchId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  size: number
  transferred: number
  status: TransferStatus
  startedAt?: number
  completedAt?: number
  speed: number
  error?: string
  retryCount: number
}
export function canRetry(job: TransferJob): boolean {
  return job.status === 'FAILED' || job.status === 'CANCELLED'
}
