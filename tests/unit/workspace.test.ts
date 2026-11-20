import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultWorkspace, fitBounds, workspaceSchema } from '../../src/shared/workspace'
import { WorkspaceRepository } from '../../src/infrastructure/persistence/workspace'
import { useDesktop, serverScope } from '../../src/renderer/src/desktop/store'
import type { ServerSession } from '../../src/domain/connection/types'
import { removeTestDirectory } from '../../scripts/test-temp'

const directories: string[] = []
const server = (id: string): ServerSession => ({
  id,
  state: 'CONNECTED',
  home: '/home/test',
  hostname: id,
  distribution: 'Ubuntu',
  architecture: 'x64',
  sftp: true,
  profile: {
    id,
    displayName: id,
    host: `${id}.test`,
    port: 22,
    username: 'test',
    authenticationMethod: 'password',
  },
})
afterEach(async () => {
  vi.unstubAllGlobals()
  useDesktop.setState({
    windows: [],
    activeWindow: undefined,
    layout: defaultWorkspace(),
    ready: false,
    warning: undefined,
  })
  for (const directory of directories.splice(0))
    await removeTestDirectory(directory, 'vps-workspace-test-')
})

describe('desktop window lifecycle', () => {
  it('isolates windows by live server, keeps minimized editors, and restores maximized geometry', () => {
    vi.stubGlobal('window', { innerWidth: 1360, innerHeight: 880 })
    const state = useDesktop.getState()
    state.hydrate(defaultWorkspace())
    const first = state.open('files', server('one'))
    const second = state.open('files', server('two'))
    expect(first).not.toBe(second)
    expect(state.open('files', server('one'))).toBe(first)
    expect(useDesktop.getState().windows).toHaveLength(2)
    const original = useDesktop.getState().windows.find((w) => w.id === first)!.bounds
    state.maximize(first)
    state.minimize(first)
    state.focus(first)
    expect(useDesktop.getState().windows.find((w) => w.id === first)).toMatchObject({
      id: first,
      mode: 'maximized',
      bounds: original,
    })
    state.maximize(first)
    expect(useDesktop.getState().windows.find((w) => w.id === first)).toMatchObject({
      mode: 'normal',
      bounds: original,
    })
    expect(useDesktop.getState().windows.map((w) => w.id)).toEqual([first, second])
    const editor = state.open('editor', server('one'), '/home/test/private.txt')
    state.dirty(editor, true)
    state.minimize(editor)
    expect(useDesktop.getState().windows.find((w) => w.id === editor)?.dirty).toBe(true)
    expect(JSON.stringify(useDesktop.getState().layout)).not.toContain('private.txt')
  })
  it('restores layout using host/account identity and leaves restored terminals dormant', () => {
    vi.stubGlobal('window', { innerWidth: 1360, innerHeight: 880 })
    const s = server('one')
    useDesktop.getState().hydrate(defaultWorkspace())
    const id = useDesktop.getState().open('terminal', s)
    useDesktop.getState().maximize(id)
    useDesktop.getState().minimize(id)
    const layout = structuredClone(useDesktop.getState().layout)
    useDesktop.setState({ windows: [], activeWindow: undefined })
    useDesktop.getState().hydrate(layout)
    useDesktop.getState().attach({ ...s, id: 'new-live-session' })
    expect(useDesktop.getState().windows[0]).toMatchObject({
      sessionId: 'new-live-session',
      mode: 'minimized',
      started: false,
      restoreMode: 'maximized',
    })
    expect(useDesktop.getState().windows[0].scope).toBe(serverScope(s))
    useDesktop.getState().close(useDesktop.getState().windows[0].id)
    expect(useDesktop.getState().layout.windows[0].open).toBe(false)
  })
  it('keeps complete windows within the available desktop at minimum size', () => {
    const bounds = fitBounds(
      { x: 2000, y: 1200, width: 1400, height: 900 },
      { width: 960, height: 536 },
    )
    expect(bounds).toEqual({ x: 0, y: 0, width: 960, height: 536 })
    expect(
      fitBounds({ x: -50, y: -60, width: 350, height: 250 }, { width: 960, height: 536 }),
    ).toEqual({ x: 0, y: 0, width: 560, height: 350 })
  })
})

describe('workspace persistence', () => {
  it('atomically serializes layout writes in a separate file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-test-'))
    directories.push(directory)
    const repo = new WorkspaceRepository(directory)
    expect((await repo.load()).layout).toEqual(defaultWorkspace())
    await Promise.all([
      repo.save({ ...defaultWorkspace(), pinned: ['files'] }),
      repo.save({ ...defaultWorkspace(), pinned: ['terminal'] }),
    ])
    await repo.flush()
    const restored = await new WorkspaceRepository(directory).load()
    expect(restored.layout.pinned).toEqual(['terminal'])
    expect(restored.warning).toBeUndefined()
    expect(
      Object.keys(JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))),
    ).toEqual(['version', 'pinned', 'windows'])
  })
  it('preserves corrupt/newer layouts and refuses to overwrite them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-test-'))
    directories.push(directory)
    const original = '{"version":99,"private":"preserve"}'
    await writeFile(join(directory, 'workspace.json'), original)
    const repo = new WorkspaceRepository(directory)
    expect((await repo.load()).warning).toContain('preserved')
    expect(() => repo.save(defaultWorkspace())).toThrow('preserved')
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(original)
    expect(
      workspaceSchema.safeParse({ ...defaultWorkspace(), credentials: 'forbidden' }).success,
    ).toBe(false)
  })
})
