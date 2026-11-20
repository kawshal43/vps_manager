export interface InstalledPackage {
  name: string
  version: string
  architecture: string
  size: number
  description: string
  manual: boolean
  held: boolean
  essential: boolean
  protected: boolean
  priority: string
  protectedReason?: string
}
export interface PackageInventory {
  packages: InstalledPackage[]
  snapshot: string
  uid: number
  at: number
}
export interface DeploymentInput {
  name: string
  path: string
  service?: string
  notes: string
}
export interface Deployment extends DeploymentInput {
  id: string
  host: string
  port: number
  username: string
  createdAt: string
}
export interface DeploymentStatus extends Deployment {
  state: 'present' | 'missing' | 'unavailable'
  reason?: string
}
export type Elevation = 'none' | 'sudo'
export interface RemovalPlan {
  token: string
  sessionId: string
  kind: 'package' | 'deployment'
  title: string
  target: string
  affected: { name: string; version: string; size: number }[]
  totalBytes: number
  itemCount: number
  blocked: string[]
  warnings: string[]
  expiresAt: number
  uid: number
  service?: string
}
export interface ApplicationOperation {
  sessionId: string
  stage: 'preparing' | 'confirming' | 'running' | 'verifying' | 'completed' | 'cancelled' | 'failed'
  message: string
}
