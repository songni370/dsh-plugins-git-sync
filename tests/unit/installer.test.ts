/**
 * Installer behaviour around DSH's `already-installed` refusal and upgrades.
 *
 * DSH's plugin manager treats an existing dependency as `already-installed`
 * even when the requested version differs. The installer must:
 * - treat an identical version as a no-op,
 * - refuse to guess when a version is unknown,
 * - replace a different version through remove + install,
 * - put the previous version back when the replacement fails,
 * - verify the installed version and report `restart-required` as pending.
 */
import { describe, expect, it } from 'vitest'
import { createInstaller } from '../../src/adapters/installer.js'
import { silentLogger } from '../../src/core/logger.js'
import type { DshBundleInfo, DshChangeResult, DshPluginManager } from '../../src/dsh.js'
import type { PluginInstaller } from '../../src/types.js'

const logger = silentLogger()

function changeResult(overrides: Partial<DshChangeResult> = {}): DshChangeResult {
  return {
    changed: true,
    application: 'applied',
    stage: 'install',
    target: 'demo-plugin',
    ...overrides,
  }
}

function bundle(overrides: Partial<DshBundleInfo> = {}): DshBundleInfo {
  return {
    name: 'demo-plugin',
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...overrides,
  }
}

interface FakeHooks {
  installedVersion?: string
  /** listBundles reports no version even though the plugin is installed. */
  unknownInstalledVersion?: boolean
  removable?: boolean
  /** The first install throws already-installed, as DSH does for an existing dependency. */
  throwAlreadyInstalled?: boolean
  /** The install that follows the removal fails once (e.g. incompatible-version). */
  failUpgradeOnce?: boolean
  /** listBundles keeps reporting an old version after a successful install. */
  staleListVersion?: string
  /** A normal install reports restart-required. */
  restartRequired?: boolean
}

function manager(hooks: FakeHooks = {}) {
  let installs = 0
  let removals = 0
  let current: { version: string | undefined } | undefined = hooks.unknownInstalledVersion === true
    ? { version: undefined }
    : { version: hooks.installedVersion ?? '1.0.0' }

  const fake: DshPluginManager = {
    async listPlugins() { return [] },
    async listBundles() {
      if (current === undefined) return []
      return [bundle({
        version: current.version,
        ...(current.version === undefined
          ? {}
          : { installTarget: { spec: `demo-plugin@${current.version}`, version: current.version } }),
        removable: hooks.removable ?? true,
      })]
    },
    async inspect(spec: string) {
      return { status: 'accepted', kind: 'registry', name: spec, version: '2.0.0', bundle: true, registry: null }
    },
    async installBundle(spec: string) {
      installs += 1
      if (hooks.throwAlreadyInstalled === true && installs === 1) {
        throw Object.assign(new Error('demo-plugin is already installed'), { code: 'already-installed' })
      }
      const at = spec.lastIndexOf('@')
      const version = at > 0 ? spec.slice(at + 1) : '0.0.0'
      if (hooks.failUpgradeOnce === true && installs === 2) {
        return changeResult({
          changed: false,
          application: 'failed',
          target: spec,
          error: { code: 'incompatible-version', diagnostic: 'incompatible with this dsh runtime' },
        })
      }
      current = { version: hooks.staleListVersion ?? version }
      if (hooks.restartRequired === true) {
        return changeResult({ application: 'restart-required', target: spec, version })
      }
      return changeResult({ target: spec, version })
    },
    async removeBundle() {
      removals += 1
      current = undefined
      return changeResult({ stage: 'remove', target: 'demo-plugin' })
    },
    async setBundleEnabled() { return changeResult({ stage: 'enable' }) },
    async setPluginEnabled() { return changeResult({ stage: 'enable' }) },
  }
  return { fake, counts: () => ({ installs, removals }), installedVersion: () => current?.version ?? null }
}

function installerWith(fake: DshPluginManager): PluginInstaller {
  return createInstaller({ pluginManager: fake, activeProfile: 'desktop', logger })
}

describe('installer already-installed handling', () => {
  it('treats the same version as a successful no-op', async () => {
    const { fake, counts } = manager({ installedVersion: '2.0.0', throwAlreadyInstalled: true })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(outcome.message).toContain('already installed')
    expect(counts()).toEqual({ installs: 1, removals: 0 })
  })

  it('replaces an installed older version through remove + install', async () => {
    const { fake, counts, installedVersion } = manager({ installedVersion: '1.0.0', throwAlreadyInstalled: true })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.version).toBe('2.0.0')
    expect(installedVersion()).toBe('2.0.0')
    expect(counts()).toEqual({ installs: 2, removals: 1 })
  })

  it('refuses to replace a non-removable bundle and explains why', async () => {
    const { fake, counts } = manager({ installedVersion: '1.0.0', throwAlreadyInstalled: true, removable: false })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('无法自动升级')
    expect(counts()).toEqual({ installs: 1, removals: 0 })
  })

  it('keeps a normal successful install unchanged', async () => {
    const { fake, counts } = manager({ installedVersion: '1.0.0' })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.version).toBe('2.0.0')
    expect(counts()).toEqual({ installs: 1, removals: 0 })
  })
})

describe('installer failure handling', () => {
  it('fails instead of silently succeeding when the installed version is unknown', async () => {
    const { fake } = manager({ unknownInstalledVersion: true, throwAlreadyInstalled: true })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('无法读取当前版本')
    expect(outcome.error).toBe('already-installed')
  })

  it('fails when the target version is unknown', async () => {
    const { fake } = manager({ installedVersion: '1.0.0', throwAlreadyInstalled: true })
    const outcome = await installerWith(fake).install('demo-plugin', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: null,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('无法确认目标版本')
  })

  it('restores the previous version when the upgrade install fails', async () => {
    const { fake, counts, installedVersion } = manager({
      installedVersion: '1.0.0',
      throwAlreadyInstalled: true,
      failUpgradeOnce: true,
    })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('已恢复旧版')
    expect(installedVersion()).toBe('1.0.0')
    expect(counts()).toEqual({ installs: 3, removals: 1 })
  })

  it('fails when the installed version does not match the requested version after install', async () => {
    const { fake } = manager({ staleListVersion: '1.0.0' })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('version-mismatch')
    expect(outcome.message).toContain('版本校验失败')
  })

  it('reports restart-required as pending activation instead of applied', async () => {
    const { fake } = manager({ restartRequired: true })
    const outcome = await installerWith(fake).install('demo-plugin@2.0.0', {
      profile: 'desktop',
      name: 'demo-plugin',
      version: '2.0.0',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.pendingActivation).toBe(true)
    expect(outcome.application).toBe('restart-required')
  })
})
