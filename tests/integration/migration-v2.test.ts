/**
 * End-to-end test for the one-time v1 -> v2 repository migration.
 *
 * A real v1 repository is seeded with a bare Git commit; the real engine then
 * synchronizes once, which must migrate the repository in place: v2 manifest,
 * policy, device manifest, `migratedFrom` marker, pre-migration tag, a
 * `Result: migrated` trailer and a still-readable v1 mirror.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBareRepo, createFakeDevice, readRepoFile, type FakeDevice } from './fake-dsh.js'
import { parseManifestV2 } from '../../src/services/repo-v2.js'

const PROFILE = 'desktop'
const AT = '2026-11-18T00:00:00.000Z'

interface TestContext {
  root: string
  bareRepo: string
  device: FakeDevice
}

let ctx: TestContext

function git(bareRepo: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', bareRepo, ...args], { encoding: 'utf8' })
}

/** Seed a v1 repository with one remote plugin (`beta`) and one device snapshot. */
async function seedV1Repository(bareRepo: string, deviceId: string, deviceName: string): Promise<void> {
  const work = join(bareRepo, '..', 'seed-work')
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '-q', bareRepo, work], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'config', 'core.autocrlf', 'false'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'config', 'core.eol', 'lf'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
  await mkdir(join(work, 'profiles', PROFILE), { recursive: true })
  await mkdir(join(work, 'devices', deviceId), { recursive: true })
  await writeFile(
    join(work, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      generator: { name: 'dsh-plugins-git-sync', version: '0.2.13' },
      createdAt: AT,
      updatedAt: AT,
      profiles: { [PROFILE]: { pluginCount: 1, updatedAt: AT } },
      devices: [deviceId],
    }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(work, 'profiles', PROFILE, 'plugins.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      profile: PROFILE,
      updatedAt: AT,
      plugins: {
        beta: {
          id: 'beta',
          name: 'beta',
          version: '1.0.0',
          origin: 'npm',
          installSpec: 'beta@1.0.0',
          enabled: true,
          builtIn: false,
          syncable: true,
          pathOnly: false,
          rows: [],
          updatedAt: AT,
          updatedBy: 'dev-old',
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(work, 'devices', deviceId, `${PROFILE}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      device: {
        id: deviceId,
        name: deviceName,
        platform: 'darwin',
        arch: 'arm64',
        dshVersion: '0.2.2-rc.5',
        pluginVersion: '0.2.13',
      },
      profile: PROFILE,
      updatedAt: AT,
      plugins: [],
    }, null, 2)}\n`,
    'utf8',
  )
  execFileSync('git', ['-C', work, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'v1 repository'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'branch', '-M', 'main'], { stdio: 'pipe' })
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main'], { stdio: 'pipe' })
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-sync-migrate-'))
  const bareRepo = createBareRepo(root)
  const device = await createFakeDevice({ root, name: 'migrator', repoUrl: bareRepo })
  device.addPlugin({ name: 'alpha', version: '1.0.0', enabled: true, configs: {} })
  await seedV1Repository(bareRepo, device.device.id, 'migrator')
  ctx = { root, bareRepo, device }
}, 120_000)

afterAll(async () => {
  if (ctx !== undefined) await rm(ctx.root, { recursive: true, force: true })
})

describe('v1 -> v2 repository migration', () => {
  it('migrates in one commit, keeps the v1 mirror and tags the pre-migration state', async () => {
    const result = await ctx.device.engine.sync({ confirmDestructive: true })
    expect(result.ok).toBe(true)

    // Local effects: the new plugin from the repository and the local push.
    expect(ctx.device.plugin('alpha')).toBeDefined()
    expect(ctx.device.plugin('beta')).toBeDefined()

    // v2 layout and migration marker.
    const manifest = parseManifestV2(JSON.parse(readRepoFile(ctx.bareRepo, 'manifest.json')))
    expect(manifest?.schemaVersion).toBe(2)
    expect(manifest?.migratedFrom).toBe(1)
    expect(manifest?.devices.map(record => record.id)).toContain(ctx.device.device.id)
    expect(readRepoFile(ctx.bareRepo, `devices/${ctx.device.device.id}/${PROFILE}.json`)).toContain('"schemaVersion": 2')

    // Legacy v1 files stay readable for rollback/downgrade.
    const mirror = JSON.parse(readRepoFile(ctx.bareRepo, `profiles/${PROFILE}/plugins.json`))
    expect(mirror.schemaVersion).toBe(1)
    expect(Object.keys(mirror.plugins).sort()).toEqual(['alpha', 'beta'])

    // The pre-migration commit is tagged and the migration trailer is recorded.
    expect(git(ctx.bareRepo, ['rev-parse', 'refs/tags/pre-v2-migration']).trim()).not.toBe('')
    expect(git(ctx.bareRepo, ['log', '-1', 'main', '--format=%B'])).toContain('Result: migrated')
  })
})
