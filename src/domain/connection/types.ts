export const connectionStates = [
  'DISCONNECTED',
  'VALIDATING',
  'CONNECTING',
  'VERIFYING_HOST_KEY',
  'AUTHENTICATING',
  'INITIALIZING_SESSION',
  'CONNECTED',
  'AUTHENTICATION_FAILED',
  'CONNECTION_FAILED',
  'CONNECTION_LOST',
  'RECONNECTING',
  'DISCONNECTING',
] as const
export type ConnectionState = (typeof connectionStates)[number]
export interface ServerProfile {
  id: string
  displayName: string
  host: string
  port: number
  username: string
  authenticationMethod: 'password' | 'key'
  privateKeyReference?: string
  lastConnectedAt?: string
  lastDirectory?: string
  hasCredential?: boolean
}
export interface ServerSession {
  id: string
  profile: ServerProfile
  state: ConnectionState
  home: string
  hostname: string
  distribution: string
  architecture: string
  sftp: boolean
  warning?: string
}
export interface HostChallenge {
  id: string
  sessionId: string
  host: string
  port: number
  fingerprint: string
  keyType: string
}
export interface TrustedHost {
  host: string
  port: number
  fingerprint: string
  keyType: string
  acceptedAt: string
}
export interface Preferences {
  theme: 'light' | 'dark' | 'system'
  hiddenFiles: boolean
  concurrency: number
  monitoringInterval: number
  lastProfileId?: string
  width: number
  height: number
}
export const defaultPreferences: Preferences = {
  theme: 'light',
  hiddenFiles: false,
  concurrency: 2,
  monitoringInterval: 5,
  width: 1360,
  height: 880,
}
