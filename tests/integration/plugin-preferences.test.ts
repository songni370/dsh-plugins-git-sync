/**
 * Per-device plugin preferences: "this device only" availability and a local
 * enabled override.
 *
 * Exercises the real engine, repository store, v2 bridge and planner against a
 * local bare repository; only the Host plugin manager/config editor are fake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncError } from '../../src/core/errors.js'
import { createBareRepo, createFakeDevice, readRepoFile, type FakeDevice } from './fake-dsh.js'

interface TestContext {
  root: string
  bareRepo: string
  mac: FakeDevice
  win: FakeDevice
}

let ctx: TestContext

/** Fail the test with a readable message when a call unexpectedly succeeds. */
async function expectRejection(promise: Promise<unknown>, code: string): Promise<SyncError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError)
    expect((error as SyncError).code).toBe(code)
    return error as SyncError
  }
  throw new Error(`expected a SyncError with code ${code}, but the call succeeded`)
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-prefs-'))
  const bareRepo = createBareRepo(root)
  const mac = await createFakeDevice({ root, name: 'mac', repoUrl: bareRepo, platform: 'darwin' })
  const win = await createFakeDevice({ root, name: 'win', repoUrl: bareRepo, platform: 'win32' })
  ctx = { root, bareRepo, mac, win }
}, 120_000)

afterAll(async () => {
  if (ctx !== undefined) await rm(ctx.root, { recursive: true, force: true })
})

describe('per-device plugin preferences', () => {
  it('restricts a plugin to this device and asks the other device to remove it', async () => {
    ctx.mac.addPlugin({ name: 'alpha', version: '1.0.0', enabled: true, configs: {} })
    const backup = await ctx.mac.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)
    const firstSync = await ctx.win.engine.sync({ confirmDestructive: true })
    expect(firstSync.ok).toBe(true)
    expect(ctx.win.plugin('alpha')?.version).toBe('1.0.0')

    const list = await ctx.mac.engine.setPluginPreferences({
      pluginId: 'alpha',
      scope: 'self',
      enabledOverride: false,
    })
    const row = list.rows.find(item => item.id === 'alpha')
    expect(row?.scopeSelfOnly).toBe(true)
    expect(row?.enabledOverride).toBe(false)
    // The override is local: this device is disabled, the other device keeps
    // the plugin enabled until it reacts to the scope restriction.
    expect(ctx.mac.plugin('alpha')?.enabled).toBe(false)
    expect(ctx.win.plugin('alpha')?.enabled).toBe(true)

    const deviceFile = JSON.parse(
      readRepoFile(ctx.bareRepo, `devices/${ctx.mac.device.id}/desktop.json`),
    ) as { plugins: Record<string, { scope: { mode: string; devices?: string[] }; enabled: boolean; enabledOverride?: boolean }> }
    expect(deviceFile.plugins['alpha']?.scope).toEqual({ mode: 'devices', devices: [ctx.mac.device.id] })
    expect(deviceFile.plugins['alpha']?.enabled).toBe(true)
    expect(deviceFile.plugins['alpha']?.enabledOverride).toBe(false)

    // The other device must not silently keep a plugin the owner restricted.
    await expectRejection(ctx.win.engine.sync({ confirmDestructive: true }), 'conflict-present')
    const removal = await ctx.win.engine.sync({
      confirmDestructive: true,
      resolutions: [{ pluginId: 'alpha', choice: 'remote' }],
    })
    expect(removal.ok).toBe(true)
    expect(ctx.win.plugin('alpha')).toBeUndefined()
    // The other device removed the plugin because of the owner's restriction,
    // which is not a deletion the owner has to resolve again.
    const winFile = JSON.parse(
      readRepoFile(ctx.bareRepo, `devices/${ctx.win.device.id}/desktop.json`),
    ) as { removed: Array<{ id: string }> }
    expect(winFile.removed.map(entry => entry.id)).not.toContain('alpha')
  }, 120_000)

  it('disables a plugin only on this device', async () => {
    ctx.mac.addPlugin({ name: 'beta', version: '2.0.0', enabled: true, configs: {} })
    const backup = await ctx.mac.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)
    const firstSync = await ctx.win.engine.sync({ confirmDestructive: true })
    expect(firstSync.ok).toBe(true)
    expect(ctx.win.plugin('beta')?.enabled).toBe(true)

    const list = await ctx.mac.engine.setPluginPreferences({ pluginId: 'beta', enabledOverride: false })
    const row = list.rows.find(item => item.id === 'beta')
    expect(row?.enabledOverride).toBe(false)
    expect(ctx.mac.plugin('beta')?.enabled).toBe(false)

    // The shared vote stays enabled, so the other device is untouched.
    const secondSync = await ctx.win.engine.sync({ confirmDestructive: true })
    expect(secondSync.ok).toBe(true)
    expect(ctx.win.plugin('beta')?.enabled).toBe(true)

    // Clearing the override makes this device follow the shared state again.
    const cleared = await ctx.mac.engine.setPluginPreferences({ pluginId: 'beta', enabledOverride: null })
    const clearedRow = cleared.rows.find(item => item.id === 'beta')
    expect(clearedRow?.enabledOverride).toBeUndefined()
    const followUp = await ctx.mac.engine.sync({ confirmDestructive: true })
    expect(followUp.ok).toBe(true)
    expect(ctx.mac.plugin('beta')?.enabled).toBe(true)
  }, 120_000)
})
