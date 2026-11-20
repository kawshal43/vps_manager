import { spawn } from 'node:child_process'
import process from 'node:process'
// Codex and some build hosts set this for their own Node helpers. Desktop children
// must run Electron as a browser application, while the parent environment stays intact.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
)
const child = spawn(
  process.execPath,
  ['node_modules/electron-vite/bin/electron-vite.js', process.argv[2] || 'dev'],
  { env, stdio: 'inherit', windowsHide: true },
)
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
