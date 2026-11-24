/**
 * Device identity and the public pool.
 *
 * The settings page shows one 「仅本设备」 checkbox per plugin: unchecked means
 * the plugin belongs to the public pool (every device gets it), checked means
 * only that device keeps it. A device with a brand-new name receives the pool
 * only; reusing an existing device name also restores that device's private
 * plugins. Deleting from the pool asks the remaining devices before they
 * uninstall.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncError } from '../../src/core/errors.js'
import {
  createBareRepo,
  createFakeDevice,
  readRepoFile,
  type FakeDevice,
} from './fake-dsh.js'

interface TestContext {
  root: string
  identityRepo: string
  deletionRepo: string
  mac: FakeDevice
  macAgain: FakeDevice
  pc: FakeDevice
  owner: FakeDevice
  joiner: FakeDevice
}

let ctx: TestContext

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-identity-'))
  const identityRepo = createBareRepo(root, 'identity.git')
  const deletionRepo = createBareRepo(root, 'deletion.git')
  const mac = await createFakeDevice({ root, name: 'mac', repoUrl: identityRepo, platform: 'darwin' })
  const macAgain = await createFakeDevice({ root, name: 'mac', repoUrl: identityRepo, platform: 'win32' })
  const pc = await createFakeDevice({ root, name: 'pc', repoUrl: identityRepo, platform: 'linux' })
  const owner = await createFakeDevice({ root, name: 'owner', repoUrl: deletionRepo, platform: 'darwin' })
  const joiner = await createFakeDevice({ root, name: 'joiner', repoUrl: deletionRepo, platform: 'linux' })
  ctx = { root, identityRepo, deletionRepo, mac, macAgain, pc, owner, joiner }
}, 120_000)

afterAll(async () => {
  if (ctx !== undefined) await rm(ctx.root, { recursive: true, force: true })
})

describe('device names and the public pool', () => {
  it('restores private plugins for an existing name and only the pool for a new name', async () => {
    ctx.mac.addPlugin({ name: 'pub', version: '1.0.0', enabled: true, configs: {} })
    ctx.mac.addPlugin({ name: 'priv', version: '1.0.0', enabled: true, configs: {} })
    const backup = await ctx.mac.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)
    const restricted = await ctx.mac.engine.setPluginPreferences({ pluginId: 'priv', scope: 'self' })
    expect(restricted.rows.find(row => row.id === 'priv')?.scopeSelfOnly).toBe(true)

    // Reusing the name restores the public pool plus that device's private set.
    const sameName = await ctx.macAgain.engine.sync({ confirmDestructive: true })
    expect(sameName.ok).toBe(true)
    expect(ctx.macAgain.plugin('pub')).toBeDefined()
    expect(ctx.macAgain.plugin('priv')).toBeDefined()

    // A fresh name receives the public pool only.
    const fresh = await ctx.pc.engine.sync({ confirmDestructive: true })
    expect(fresh.ok).toBe(true)
    expect(ctx.pc.plugin('pub')).toBeDefined()
    expect(ctx.pc.plugin('priv')).toBeUndefined()
  })
})

describe('public-pool deletion intent', () => {
  it('asks the other devices before removing a pool plugin', async () => {
    ctx.owner.addPlugin({ name: 'alpha', version: '1.0.0', enabled: true, configs: {} })
    const backup = await ctx.owner.engine.backup({ confirmDestructive: true })
    expect(backup.ok).toBe(true)
    const joined = await ctx.joiner.engine.sync({ confirmDestructive: true })
    expect(joined.ok).toBe(true)
    expect(ctx.joiner.plugin('alpha')).toBeDefined()

    // Owner uninstalls locally; resolving the local-deleted conflict with
    // "local" records a public-pool deletion.
    ctx.owner.removePlugin('alpha')
    const resolved = await ctx.owner.engine.sync({
      confirmDestructive: true,
      resolutions: [{ pluginId: 'alpha', choice: 'local' }],
    })
    expect(resolved.ok).toBe(true)
    expect(readRepoFile(ctx.deletionRepo, 'pool/removed.json')).toContain('"alpha"')

    // The other device is asked before it removes the plugin.
    await expectRejection(ctx.joiner.engine.sync({ confirmDestructive: true }), 'conflict-present')
    const removed = await ctx.joiner.engine.sync({
      confirmDestructive: true,
      resolutions: [{ pluginId: 'alpha', choice: 'remote' }],
    })
    expect(removed.ok).toBe(true)
    expect(ctx.joiner.plugin('alpha')).toBeUndefined()
  })
})
