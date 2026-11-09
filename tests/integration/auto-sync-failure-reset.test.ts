/**
 * Regression tests for the auto-sync failure notice state.
 *
 * The settings page surfaces `status.autoSyncFailures` as
 * "automatic sync failed N time(s)". That counter used to be cleared only by a
 * successful *automatic* run, so a manual sync/backup/restore that repaired the
 * repository left the notice visible forever. Every successful repository
 * operation must reset it (and tell the scheduler so it can resume).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBareRepo, createFakeDevice, type FakeDevice } from './fake-dsh.js'

let root: string
let device: FakeDevice
let recoveries = 0

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-recovery-'))
  const bareRepo = createBareRepo(root)
  device = await createFakeDevice({
    root,
    name: 'mac',
    repoUrl: bareRepo,
    onOperationSuccess: () => {
      recoveries += 1
    },
  })
}, 120_000)

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** Simulate the count persisted by earlier automatic failures. */
async function seedAutoSyncFailures(count: number): Promise<void> {
  const state = await device.stateStore.read()
  state.autoSyncFailures = count
  await device.stateStore.write(state)
}

async function autoSyncFailures(): Promise<number> {
  const { status } = await device.engine.status()
  return status.autoSyncFailures ?? 0
}

describe('auto-sync failure count', () => {
  it('clears after a successful manual sync that changed the repository', async () => {
    device.addPlugin({ name: 'alpha', version: '1.0.0', enabled: true, configs: {} })
    await seedAutoSyncFailures(2)
    expect(await autoSyncFailures()).toBe(2)

    const result = await device.engine.sync({ confirmDestructive: true })
    expect(result.ok).toBe(true)
    expect(result.noChanges).toBe(false)
    expect(await autoSyncFailures()).toBe(0)
    expect(recoveries).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('clears after a successful sync with no changes', async () => {
    await seedAutoSyncFailures(3)
    const result = await device.engine.sync({ confirmDestructive: true })
    expect(result.ok).toBe(true)
    expect(result.noChanges).toBe(true)
    expect(await autoSyncFailures()).toBe(0)
  }, 120_000)

  it('clears after a successful backup and after a successful restore', async () => {
    await seedAutoSyncFailures(2)
    const backup = await device.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)
    expect(await autoSyncFailures()).toBe(0)

    await seedAutoSyncFailures(2)
    const restore = await device.engine.restore({ confirmDestructive: true })
    expect(restore.ok).toBe(true)
    expect(await autoSyncFailures()).toBe(0)
  }, 120_000)

  it('keeps the count when an operation fails', async () => {
    await seedAutoSyncFailures(2)
    const original = await device.configStore.read()
    await device.configStore.write({ ...original, repoUrl: join(root, 'missing.git') })
    let failed = false
    try {
      await device.engine.backup({ confirmDestructive: true })
    } catch {
      failed = true
    }
    await device.configStore.write(original)
    expect(failed).toBe(true)
    expect(await autoSyncFailures()).toBe(2)
  }, 120_000)
})
