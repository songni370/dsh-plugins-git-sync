/**
 * A conflict must survive in state until it is decided.
 *
 * Regression: a conflict-present error left state.conflicts empty, so the page
 * disagreed with a fresh plan, a restart forgot the conflict, and the status
 * payload could not explain why automatic synchronization was paused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncError } from '../../src/core/errors.js'
import { createBareRepo, createFakeDevice, type FakeDevice } from './fake-dsh.js'

let root: string
let device: FakeDevice

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-conflict-'))
  const bareRepo = createBareRepo(root)
  device = await createFakeDevice({ root, name: 'alpha', repoUrl: bareRepo, platform: 'darwin' })
}, 120_000)

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('conflict state persistence', () => {
  it('persists an unresolved conflict and clears it after the resolution', async () => {
    device.addPlugin({ name: 'gamma', version: '1.0.0', enabled: true, configs: {} })
    const backup = await device.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)

    device.removePlugin('gamma')
    let caught: SyncError | undefined
    try {
      await device.engine.sync()
    } catch (error) {
      caught = error as SyncError
    }
    expect(caught?.code).toBe('conflict-present')

    const persisted = await device.stateStore.read()
    expect(persisted.conflicts).toHaveLength(1)
    expect(persisted.conflicts[0]?.pluginId).toBe('gamma')
    expect(persisted.conflicts[0]?.conflict.reason).toBe('local-deleted')

    const resolved = await device.engine.sync({
      resolutions: [{ pluginId: 'gamma', choice: 'local' }],
      confirmDestructive: true,
    })
    expect(resolved.ok).toBe(true)
    expect((await device.stateStore.read()).conflicts).toEqual([])
  }, 120_000)
})
