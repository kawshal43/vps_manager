export interface RemoteFile {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtime: number
  mode: number
  uid: number
  gid: number
}
export interface FileIdentity {
  size: number
  mtime: number
  mode: number
  uid: number
  gid: number
  hash?: string
}
export interface TextDocument {
  path: string
  content: string
  identity: FileIdentity
  lineEnding: 'LF' | 'CRLF'
  bom: boolean
}
export type ConflictPolicy = 'ask' | 'skip' | 'replace' | 'keep-both'
