import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { AppError } from '../errors/app-error'
import { assertMutable, validatePath } from '../filesystem/policy'
import { relativeWebsitePath, type FileEntry, type FileChanges, type WebsiteInput } from './types'

export const MAX_FILES = 10000
export const MAX_BYTES = 2 * 1024 ** 3
export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
export function childPath(root: string, relative: string): string {
  relativeWebsitePath.parse(relative)
  const path = posix.join(validatePath(root), relative)
  if (!path.startsWith(validatePath(root) + '/'))
    throw new AppError('INVALID_PATH', 'Path escaped the project directory.')
  return path
}
export function deploymentPath(path: string, home: string): string {
  const clean = validatePath(path)
  assertMutable(clean)
  if (
    clean !== path.replace(/\/$/, '') ||
    clean === home ||
    clean.split('/').length < 3 ||
    ['/var/www', '/srv/www', '/usr/share/nginx/html'].includes(clean) ||
    /^\/(?:etc|usr|var\/(?:lib|cache|log))(?:\/|$)/.test(clean) ||
    /\/(?:postgresql|mysql|docker|letsencrypt|\.ssh|\.vps-websites[^/]*|uploads?|media|storage|data|pgdata)(?:\/|$)/i.test(
      clean,
    )
  )
    throw new AppError(
      'PERMISSION_DENIED',
      'Choose a dedicated application directory, away from system and database storage.',
    )
  return clean
}
export function isProtected(path: string, extras: string[] = []): boolean {
  const parts = path.toLowerCase().split('/')
  return (
    parts.some(
      (p) =>
        /^(?:\.git|\.ssh|\.env(?:\..*)?|node_modules|uploads?|media|storage|data|pgdata|postgresql|mysql|certs?|certificates?|secrets?|\.vps-websites.*)$/.test(
          p,
        ) || /\.(?:pem|key|p12|pfx|keystore|sql|dump|sqlite|sqlite3)$/.test(p),
    ) || extras.some((p) => path === p || path.startsWith(p + '/'))
  )
}
export function compareFiles(
  current: FileEntry[],
  source: FileEntry[],
  method: 'full' | 'partial' | 'rebuild',
): FileChanges {
  const old = new Map(current.map((f) => [f.path, f]))
  const next = new Map(source.map((f) => [f.path, f]))
  return {
    added: source.filter((f) => !old.has(f.path)).map((f) => f.path),
    changed: source
      .filter((f) => old.has(f.path) && old.get(f.path)!.hash !== f.hash)
      .map((f) => f.path),
    removed: method === 'full' ? current.filter((f) => !next.has(f.path)).map((f) => f.path) : [],
    unchanged: source.filter((f) => old.get(f.path)?.hash === f.hash).length,
  }
}
export function manifestHash(files: FileEntry[]): string {
  return hash(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))))
}
export function infrastructurePaths(config: WebsiteInput): string[] {
  return config.compose?.files ?? []
}
export function safeGitUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw new AppError('INVALID_REQUEST', 'Use an HTTPS or ssh:// Git repository URL.')
  }
  if (
    !['https:', 'ssh:'].includes(u.protocol) ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol === 'https:' && u.username) ||
    (u.protocol === 'ssh:' && u.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(u.username)) ||
    /[\s\x00-\x1f]/.test(input)
  )
    throw new AppError(
      'INVALID_REQUEST',
      'Git URLs must not contain passwords, tokens, query parameters or unsafe protocols.',
    )
  return u.href
}
export function redactLog(text: string, secrets: string[] = []): string {
  let clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  for (const secret of secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length))
    clean = clean.split(secret).join('[redacted]')
  return clean
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 2000)
}

export class DeploymentLogSanitizer {
  private pending = ''
  private privateKey = false
  private dropping = false
  constructor(
    private emit: (line: string) => void,
    private secrets: string[] = [],
  ) {}
  feed(text: string): void {
    if (this.dropping) {
      const end = text.indexOf('\n')
      if (end < 0) return
      text = text.slice(end + 1)
      this.dropping = false
    }
    const lines = (this.pending + text).split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.line(line)
    if (this.pending.length > 8192) {
      this.pending = ''
      this.dropping = true
      this.emit('[overlong output line omitted]')
    }
  }
  flush(): void {
    if (this.pending) this.line(this.pending)
    this.pending = ''
  }
  private line(line: string): void {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) {
      this.privateKey = true
      this.emit('[private key omitted]')
      return
    }
    if (this.privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(line)) this.privateKey = false
      return
    }
    if (line.length > 8192) {
      this.emit('[overlong output line omitted]')
      return
    }
    if (line.trim()) this.emit(redactLog(line, this.secrets))
  }
}
