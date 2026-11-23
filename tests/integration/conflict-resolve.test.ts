/**
 * Conflicts are resolved from the plugin list, one row at a time.
 *
 * The page turns each conflict into a row dropdown; the Host exposes a single
 * endpoint that applies one explicit choice, runs only that plugin's actions,
 * commits, and returns the refreshed list with whatever conflicts remain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncError } from '../../src/core/errors.js'
import { createBareRepo, createFakeDevice, type FakeDevice } from './fake-dsh.js'

let root: string
let mac: FakeDevice
let win: FakeDevice

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-conflict-resolve-'))
  const bareRepo = createBareRepo(root)
  mac = await createFakeDevice({ root, name: 'mac', repoUrl: bareRepo, platform: 'darwin' })
  win = await createFakeDevice({ root, name: 'win', repoUrl: bareRepo, platform: 'win32' })
}, 120_000)

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('resolving one conflict from the list', () => {
  it('keeps the repository version when the row chooses it', async () => {
    mac.addPlugin({ name: 'gamma', version: '1.0.0', enabled: true, configs: {} })
    expect((await mac.engine.backup({ confirmDestructive: true })).ok).toBe(true)
    expect((await win.engine.sync()).ok).toBe(true)
    expect(win.plugin('gamma')).toBeDefined()

    mac.removePlugin('gamma')
    let caught: SyncError | undefined
    try {
      await mac.engine.sync()
    } catch (error) {
      caught = error as SyncError
    }
    expect(caught?.code).toBe('conflict-present')

    const list = await mac.engine.listPlugins()
    const row = list.rows.find(item => item.id === 'gamma')
    expect(row?.conflictInfo?.reason).toBe('local-deleted')

    const resolved = await mac.engine.resolveConflict('gamma', 'remote')
    expect(resolved.rows.find(item => item.id === 'gamma')?.conflictInfo).toBeUndefined()
    expect(mac.plugin('gamma')?.version).toBe('1.0.0')
    expect((await mac.stateStore.read()).conflicts).toEqual([])
  }, 120_000)

  it('removes the local copy when another device deleted the plugin', async () => {
    mac.addPlugin({ name: 'delta', version: '2.0.0', enabled: true, configs: {} })
    expect((await mac.engine.backup({ confirmDestructive: true })).ok).toBe(true)
    expect((await win.engine.sync()).ok).toBe(true)
    expect(win.plugin('delta')).toBeDefined()

    mac.removePlugin('delta')
    expect((await mac.engine.resolveConflict('delta', 'local')).rows.find(item => item.id === 'delta')?.conflictInfo).toBeUndefined()

    let caught: SyncError | undefined
    try {
      await win.engine.sync()
    } catch (error) {
      caught = error as SyncError
    }
    expect(caught?.code).toBe('conflict-present')

    const list = await win.engine.listPlugins()
    expect(list.rows.find(item => item.id === 'delta')?.conflictInfo?.reason).toBe('remote-deleted')

    const resolved = await win.engine.resolveConflict('delta', 'remote')
    expect(resolved.rows.find(item => item.id === 'delta')?.conflictInfo).toBeUndefined()
    expect(win.plugin('delta')).toBeUndefined()
    expect((await win.stateStore.read()).conflicts).toEqual([])
  }, 120_000)
})
