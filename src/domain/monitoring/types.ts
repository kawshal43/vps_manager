export interface ServerMetrics {
  at: number
  cpuPercent: number | null
  cpuCount: number
  memoryTotal: number
  memoryAvailable: number
  swapTotal: number
  swapFree: number
  diskTotal: number
  diskUsed: number
  uptime: number
  load: number[]
}
export interface ServiceInformation {
  name: string
  description: string
  load: string
  active: string
  sub: string
}
export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'
