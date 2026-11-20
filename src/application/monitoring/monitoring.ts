import { AppError } from '../../domain/errors/app-error'
import type { ServerMetrics } from '../../domain/monitoring/types'
import type { SessionManager } from '../connection/session-manager'
import { metricsCommand } from '../../infrastructure/commands/catalog'
export function parseMetrics(
  raw: string,
  previous?: { total: number; idle: number },
): { metrics: ServerMetrics; cpu: { total: number; idle: number } } {
  const [body, diskAndUptime] = raw.split('__DISK__\n')
  const [disk, uptimeBlock] = (diskAndUptime ?? '').split('__UPTIME__\n')
  const lines = body.trim().split('\n')
  const cpuValues = lines[0].trim().split(/\s+/).slice(1, 9).map(Number)
  const cpu = { total: cpuValues.reduce((a, b) => a + b, 0), idle: cpuValues[3] + cpuValues[4] }
  const mem: Record<string, number> = {}
  for (const line of lines.slice(2)) {
    const m = /^(\w+):\s+(\d+) kB/.exec(line)
    if (m) mem[m[1]] = Number(m[2]) * 1024
  }
  const diskRow = disk?.trim().split('\n').at(-1)?.trim().split(/\s+/)
  const uptimeLines = uptimeBlock?.trim().split('\n')
  if (
    !mem.MemTotal ||
    !diskRow ||
    !uptimeLines ||
    cpuValues.length < 8 ||
    !Number.isFinite(cpu.total)
  )
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The server returned an unsupported monitoring format.',
    )
  const cpuPercent =
    previous && cpu.total > previous.total
      ? Math.max(
          0,
          Math.min(100, 100 * (1 - (cpu.idle - previous.idle) / (cpu.total - previous.total))),
        )
      : null
  return {
    cpu,
    metrics: {
      at: Date.now(),
      cpuPercent,
      cpuCount: Number(lines[1]),
      memoryTotal: mem.MemTotal,
      memoryAvailable: mem.MemAvailable ?? mem.MemFree,
      swapTotal: mem.SwapTotal ?? 0,
      swapFree: mem.SwapFree ?? 0,
      diskTotal: Number(diskRow[1]) * 1024,
      diskUsed: Number(diskRow[2]) * 1024,
      uptime: Number(uptimeLines[0].split(' ')[0]),
      load: uptimeLines[1].trim().split(/\s+/).slice(0, 3).map(Number),
    },
  }
}
export class Monitoring {
  private previous = new Map<string, { total: number; idle: number }>()
  private pending = new Map<string, Promise<ServerMetrics>>()
  constructor(private sessions: SessionManager) {}
  get(id: string): Promise<ServerMetrics> {
    const pending = this.pending.get(id)
    if (pending) return pending
    const request = this.sessions
      .exec(id, metricsCommand)
      .then((raw) => {
        const result = parseMetrics(raw, this.previous.get(id))
        this.previous.set(id, result.cpu)
        return result.metrics
      })
      .finally(() => this.pending.delete(id))
    this.pending.set(id, request)
    return request
  }
}
