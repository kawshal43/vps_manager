export type ErrorCode =
  | 'NETWORK_ERROR'
  | 'SSH_AUTH_ERROR'
  | 'HOST_KEY_ERROR'
  | 'PERMISSION_DENIED'
  | 'FILE_NOT_FOUND'
  | 'FILE_CONFLICT'
  | 'SFTP_ERROR'
  | 'TRANSFER_INTERRUPTED'
  | 'DISK_FULL'
  | 'INVALID_PATH'
  | 'OPERATION_TIMEOUT'
  | 'UNSUPPORTED_OPERATION'
  | 'SERVICE_ERROR'
  | 'CANCELLED'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ERROR'

export interface AppErrorData {
  code: ErrorCode
  message: string
  operation: string
  retryable: boolean
  suggestion: string
}
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion = 'Review the request and try again.',
    public retryable = false,
  ) {
    super(message)
  }
}
export function mapError(error: unknown, operation: string): AppErrorData {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      operation,
      retryable: error.retryable,
      suggestion: error.suggestion,
    }
  const e = error as { code?: string | number; level?: string; name?: string }
  if (e?.name === 'AbortError')
    return {
      code: 'CANCELLED',
      message: 'Operation cancelled.',
      operation,
      retryable: true,
      suggestion: 'Retry when ready.',
    }
  const values: Partial<Record<string, [ErrorCode, string, string]>> = {
    '2': ['FILE_NOT_FOUND', 'The remote entry no longer exists.', 'Refresh the directory.'],
    ENOENT: [
      'FILE_NOT_FOUND',
      'The file or directory does not exist.',
      'Check the path and refresh.',
    ],
    '3': [
      'PERMISSION_DENIED',
      'The authenticated user does not have permission.',
      'Use an account with the required permissions.',
    ],
    EACCES: ['PERMISSION_DENIED', 'Access was denied.', 'Check file permissions.'],
    ENOSPC: ['DISK_FULL', 'There is not enough disk space.', 'Free disk space before retrying.'],
    ECONNREFUSED: [
      'NETWORK_ERROR',
      'The SSH server refused the connection.',
      'Check the host, port, firewall, and SSH service.',
    ],
    ENOTFOUND: [
      'NETWORK_ERROR',
      'The server hostname could not be resolved.',
      'Check the hostname and DNS.',
    ],
    ETIMEDOUT: [
      'OPERATION_TIMEOUT',
      'The operation timed out.',
      'Check the network and server status.',
    ],
    ECONNRESET: [
      'NETWORK_ERROR',
      'The SSH connection was interrupted.',
      'Reconnect before starting new operations.',
    ],
  }
  if (e?.level === 'client-authentication')
    return {
      code: 'SSH_AUTH_ERROR',
      message: 'SSH authentication failed.',
      operation,
      retryable: true,
      suggestion: 'Check your username and password or private key.',
    }
  const mapped = values[String(e?.code)]
  if (mapped)
    return {
      code: mapped[0],
      message: mapped[1],
      operation,
      retryable: true,
      suggestion: mapped[2],
    }
  return {
    code: 'UNKNOWN_ERROR',
    message: 'The operation could not be completed.',
    operation,
    retryable: true,
    suggestion: 'Refresh, verify permissions, and retry. Consult diagnostics if this persists.',
  }
}
