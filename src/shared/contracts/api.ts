import type { AppErrorData } from '../../domain/errors/app-error'
import type {
  HostChallenge,
  Preferences,
  ServerProfile,
  ServerSession,
  TrustedHost,
} from '../../domain/connection/types'
import type { RemoteFile, TextDocument } from '../../domain/filesystem/types'
import type { ServerMetrics, ServiceInformation } from '../../domain/monitoring/types'
import type { TransferJob } from '../../domain/transfers/types'
import type { Input, Route } from '../schemas'
import type { WorkspaceLayout } from '../workspace'
import type {
  DiscoveryResult,
  WebsiteRecord,
  DeploymentPreview,
  DeploymentHistory,
  DeploymentProgress,
  HealthResult,
} from '../../domain/websites/types'
import type {
  ApplicationOperation,
  Deployment,
  DeploymentStatus,
  PackageInventory,
  RemovalPlan,
} from '../../domain/applications/types'
export interface Outputs {
  'websites.discover': DiscoveryResult
  'websites.save': WebsiteRecord
  'websites.pickSource': { token: string; name: string } | null
  'websites.prepare': DeploymentPreview
  'websites.discard': void
  'websites.deploy': string | null
  'websites.cancel': void
  'websites.operations': DeploymentProgress[]
  'websites.history': DeploymentHistory[]
  'websites.health': HealthResult
  'websites.logs': string
  'websites.restart': void
  'websites.restore': string | null
  'websites.nginx': string
  'app.bootstrap': {
    profiles: ServerProfile[]
    preferences: Preferences
    trustedHosts: TrustedHost[]
    sessions: ServerSession[]
    transfers: TransferJob[]
    secureStorage: boolean
    version: string
  }
  'app.preferences': Preferences
  'app.diagnostics': void
  'clipboard.readText': string
  'clipboard.writeText': void
  'workspace.load': { layout: WorkspaceLayout; warning?: string }
  'workspace.save': void
  'app.editorState': void
  'profiles.remove': void
  'profiles.forgetCredentials': void
  'connection.connect': ServerSession
  'connection.disconnect': void
  'connection.cancel': void
  'connection.trust': void
  'connection.pickKey': { token: string; name: string } | null
  'files.list': { path: string; entries: RemoteFile[] }
  'files.stat': RemoteFile
  'files.resolve': RemoteFile
  'files.create': void
  'files.cancel': void
  'files.rename': void
  'files.copy': void
  'files.delete': void
  'files.chmod': void
  'files.read': TextDocument
  'files.save': TextDocument
  'transfers.upload': void
  'transfers.drop': void
  'transfers.desktopDrop': void
  'transfers.download': void
  'transfers.cancel': void
  'transfers.retry': void
  'transfers.reveal': void
  'terminal.open': string
  'terminal.input': void
  'terminal.resize': void
  'terminal.ack': void
  'terminal.close': void
  'monitoring.get': ServerMetrics
  'services.list': ServiceInformation[]
  'services.details': string
  'services.action': void
  'logs.read': string
  'system.processes': string
  'applications.packages': PackageInventory
  'applications.deployments': DeploymentStatus[]
  'applications.saveDeployment': Deployment
  'applications.forgetDeployment': void
  'applications.prepareRemoval': RemovalPlan
  'applications.executeRemoval': { completed: boolean; message: string }
  'system.inspect': { pid: number; startTime: string; detail: string }
  'system.ports': string
  'system.terminate': void
  'shell.openExternal': void
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppErrorData }
export type AppEvent =
  | { type: 'website-deployment'; operation: DeploymentProgress }
  | { type: 'application-operation'; operation: ApplicationOperation }
  | { type: 'session'; session: ServerSession }
  | { type: 'host-challenge'; challenge: HostChallenge }
  | { type: 'transfer'; job: TransferJob }
  | { type: 'terminal-data'; id: string; data: string; bytes: number }
  | { type: 'terminal-exit'; id: string }
export interface DesktopApi {
  invoke<K extends Route>(route: K, input: Input<K>): Promise<Result<Outputs[K]>>
  onEvent(listener: (event: AppEvent) => void): () => void
  droppedFiles(files: File[]): Promise<string[]>
}
declare global {
  interface Window {
    vps: DesktopApi
  }
}
