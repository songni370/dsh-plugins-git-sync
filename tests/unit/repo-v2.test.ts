import { describe, expect, it } from 'vitest'

import {
  REPO_SCHEMA_VERSION,
  defaultPolicy,
  deviceManifestPath,
  manifestPath,
  mergeDesired,
  parseDeviceManifestV2,
  parseManifestV2,
  parsePolicyV2,
  policyPath,
  serializeDeviceManifestV2,
  serializeManifestV2,
  serializePolicyV2,
} from '../../src/services/repo-v2.js'
import type {
  DesiredMergeV2,
  DeviceManifestV2,
  DevicePluginEntryV2,
  RepoManifestV2,
  RepoPolicyV2,
} from '../../src/services/repo-v2.js'

const PROFILE = 'desktop'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

/** Build a plugin declaration with predictable defaults. */
function pluginEntry(overrides: Partial<DevicePluginEntryV2> = {}): DevicePluginEntryV2 {
  const id = overrides.id ?? 'alpha'
  const version = overrides.version === undefined ? '1.0.0' : overrides.version
  return {
    id,
    version,
    enabled: true,
    installSpec: version === null ? null : `${id}@${version}`,
    origin: 'npm',
    syncable: true,
    scope: { mode: 'all' },
    versionPolicy: 'track',
    pinnedVersion: null,
    updatedAt: T0,
    updatedBy: 'dev-a',
    ...overrides,
  }
}

/** Build a device manifest, `plugins` is the per-plugin declaration map. */
function deviceManifest(
  deviceId: string,
  plugins: Record<string, DevicePluginEntryV2> = {},
  overrides: Partial<DeviceManifestV2> = {},
): DeviceManifestV2 {
  return {
    schemaVersion: 2,
    device: {
      id: deviceId,
      name: `${deviceId}-host`,
      platform: 'darwin',
      arch: 'arm64',
      dshVersion: '0.2.2',
      pluginVersion: '0.3.0',
    },
    profile: PROFILE,
    updatedAt: T0,
    baseCommit: null,
    plugins,
    removed: [],
    skills: {},
    status: { lastSyncAt: null, lastResult: 'ok', lastError: null, pendingActivation: [] },
    ...overrides,
  }
}

/** Merge as `dev-a` against the default desktop policy. */
function merge(
  devices: DeviceManifestV2[],
  options: { policy?: RepoPolicyV2; selfId?: string; localDshVersion?: string } = {},
): DesiredMergeV2 {
  return mergeDesired({
    selfId: options.selfId ?? 'dev-a',
    policy: options.policy ?? defaultPolicy(PROFILE),
    devices,
    localDshVersion: options.localDshVersion ?? '0.2.2',
  })
}

/** Default policy with the fields these tests care about overridden. */
function policyWith(
  overrides: { propagate?: boolean; allowPrerelease?: boolean; minDshVersion?: string } = {},
): RepoPolicyV2 {
  const base = defaultPolicy(PROFILE)
  return {
    ...base,
    deletion: { propagate: overrides.propagate ?? base.deletion.propagate },
    versions: { ...base.versions, allowPrerelease: overrides.allowPrerelease ?? base.versions.allowPrerelease },
    minDshVersion: overrides.minDshVersion ?? base.minDshVersion,
  }
}

/** A realistic root manifest fixture. */
function repoManifest(): RepoManifestV2 {
  return {
    schemaVersion: 2,
    generator: { name: 'dsh-plugins-git-sync', version: '0.3.0' },
    migratedFrom: 1,
    profiles: { desktop: { pluginCount: 2 } },
    devices: [
      {
        id: 'dev-a',
        name: 'mac-mini',
        platform: 'darwin',
        arch: 'arm64',
        dshVersion: '0.2.2',
        pluginVersion: '0.3.0',
        lastSyncAt: T1,
        lastCommit: 'abc123',
        updatedAt: T1,
        lastResult: 'ok',
      },
      {
        id: 'dev-b',
        name: 'linux-box',
        platform: 'linux',
        arch: 'x64',
        dshVersion: '0.2.3',
        pluginVersion: '0.3.0',
        lastSyncAt: null,
        lastCommit: null,
        updatedAt: T0,
      },
    ],
    updatedAt: T2,
  }
}

/** A realistic device manifest fixture with every optional block populated. */
function deviceFixture(): DeviceManifestV2 {
  return deviceManifest(
    'dev-a',
    {
      alpha: pluginEntry({ id: 'alpha' }),
      beta: pluginEntry({
        id: 'beta',
        version: '2.0.0',
        versionPolicy: 'pin',
        pinnedVersion: '2.0.0',
        scope: { mode: 'devices', devices: ['dev-a', 'dev-b'] },
        updatedAt: T1,
        updatedBy: 'dev-a',
      }),
    },
    {
      updatedAt: T1,
      baseCommit: 'abc123',
      removed: [
        { id: 'gamma', at: T1, name: 'Gamma' },
        { id: 'delta', at: T2 },
      ],
      skills: { cloudflare: { name: 'cloudflare', hash: 'sha256:abc', files: 3, updatedAt: T1, deleted: false } },
      status: {
        lastSyncAt: T1,
        lastResult: 'conflict',
        lastError: 'pin mismatch',
        pendingActivation: [{ pluginId: 'alpha', version: '1.0.0', reason: 'restart-required' }],
      },
    },
  )
}

/** Parse a fixture through JSON so tests start from untrusted plain objects. */
function jsonClone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

describe('repository paths and defaults', () => {
  it('exposes the v2 schema version and deterministic paths', () => {
    expect(REPO_SCHEMA_VERSION).toBe(2)
    expect(manifestPath).toBe('manifest.json')
    expect(policyPath('desktop')).toBe('policies/desktop.json')
    expect(deviceManifestPath('dev-a', 'desktop')).toBe('devices/dev-a/desktop.json')
  })

  it('builds the documented default policy', () => {
    expect(defaultPolicy('laptop')).toEqual({
      schemaVersion: 2,
      profile: 'laptop',
      sync: {
        mode: 'two-way',
        auto: { enabled: false, apply: 'safe', onStartup: true, onPluginChange: true },
      },
      deletion: { propagate: true },
      versions: { default: 'track', downgrade: 'confirm', allowPrerelease: false },
      scope: { default: 'all' },
      minDshVersion: '0.2.2',
      backupButton: { warnWhenMultiDevice: true },
    })
  })
})

describe('serialization', () => {
  it('round-trips the root manifest', () => {
    const manifest = repoManifest()
    const text = serializeManifestV2(manifest)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseManifestV2(JSON.parse(text))).toEqual(manifest)
  })

  it('round-trips the policy document', () => {
    const policy = defaultPolicy(PROFILE)
    const text = serializePolicyV2(policy)
    expect(text.endsWith('\n')).toBe(true)
    expect(parsePolicyV2(JSON.parse(text), PROFILE)).toEqual(policy)
  })

  it('round-trips the device manifest', () => {
    const device = deviceFixture()
    const text = serializeDeviceManifestV2(device)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseDeviceManifestV2(JSON.parse(text))).toEqual(device)
  })

  it('sorts object keys so insertion order cannot change the bytes', () => {
    const manifest = repoManifest()
    const text = serializeManifestV2(manifest)
    const reordered: RepoManifestV2 = {
      updatedAt: manifest.updatedAt,
      devices: manifest.devices,
      profiles: manifest.profiles,
      migratedFrom: manifest.migratedFrom,
      generator: manifest.generator,
      schemaVersion: REPO_SCHEMA_VERSION,
    }
    expect(serializeManifestV2(reordered)).toBe(text)
    expect(text.indexOf('"devices"')).toBeLessThan(text.indexOf('"generator"'))
    expect(text.indexOf('"generator"')).toBeLessThan(text.indexOf('"profiles"'))
    expect(text.startsWith('{\n  "devices"')).toBe(true)
  })
})

describe('parser validation', () => {
  it('rejects legacy and structurally invalid root manifests', () => {
    expect(parseManifestV2(null)).toBeNull()
    expect(parseManifestV2(undefined)).toBeNull()
    expect(parseManifestV2(42)).toBeNull()
    expect(parseManifestV2('manifest.json')).toBeNull()
    expect(parseManifestV2([])).toBeNull()
    expect(parseManifestV2({})).toBeNull()
    expect(parseManifestV2({ ...repoManifest(), schemaVersion: 1 })).toBeNull()
    expect(parseManifestV2({ ...repoManifest(), generator: { name: 'only-name' } })).toBeNull()
    expect(parseManifestV2({ ...repoManifest(), devices: [{ id: 'dev-a' }] })).toBeNull()
    expect(parseManifestV2({ ...repoManifest(), updatedAt: 7 })).toBeNull()

    const missingProfiles = jsonClone(repoManifest())
    delete missingProfiles['profiles']
    expect(parseManifestV2(missingProfiles)).toBeNull()
  })

  it('rejects policies that are not v2 or belong to another profile', () => {
    const policy = defaultPolicy(PROFILE)
    expect(parsePolicyV2(null, PROFILE)).toBeNull()
    expect(parsePolicyV2({}, PROFILE)).toBeNull()
    expect(parsePolicyV2(policy, 'another-profile')).toBeNull()
    expect(parsePolicyV2({ ...policy, schemaVersion: 1 }, PROFILE)).toBeNull()
    expect(parsePolicyV2({ ...policy, sync: { ...policy.sync, mode: 'sideways' } }, PROFILE)).toBeNull()
    expect(parsePolicyV2({ ...policy, versions: { ...policy.versions, default: 'pin' } }, PROFILE)).toBeNull()
    expect(parsePolicyV2({ ...policy, minDshVersion: 42 }, PROFILE)).toBeNull()
  })

  it('rejects malformed device manifests', () => {
    const device = deviceFixture()
    expect(parseDeviceManifestV2(null)).toBeNull()
    expect(parseDeviceManifestV2({})).toBeNull()
    expect(parseDeviceManifestV2({ ...device, schemaVersion: 1 })).toBeNull()
    expect(parseDeviceManifestV2({ ...device, status: { lastResult: 'nonsense' } })).toBeNull()
    expect(parseDeviceManifestV2({ ...device, device: { id: 'dev-a' } })).toBeNull()
    expect(parseDeviceManifestV2({ ...device, removed: [{ id: 'alpha' }] })).toBeNull()
    expect(
      parseDeviceManifestV2({
        ...device,
        plugins: { alpha: { ...pluginEntry(), scope: { mode: 'nonsense' } } },
      }),
    ).toBeNull()
  })

  it('tolerates missing optional fields and drops unknown keys', () => {
    const parsed = parseDeviceManifestV2({
      schemaVersion: 2,
      device: {
        id: 'dev-a',
        name: 'mac-mini',
        platform: 'darwin',
        arch: 'arm64',
        dshVersion: '0.2.2',
        pluginVersion: '0.3.0',
      },
      profile: PROFILE,
      updatedAt: T0,
      plugins: {
        alpha: {
          id: 'alpha',
          version: '1.0.0',
          enabled: true,
          origin: 'npm',
          syncable: true,
          updatedAt: T0,
          updatedBy: 'dev-a',
        },
      },
      status: { lastResult: 'ok' },
      ignoredTopLevelKey: true,
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.plugins['alpha']).toEqual({
      id: 'alpha',
      version: '1.0.0',
      enabled: true,
      installSpec: null,
      origin: 'npm',
      syncable: true,
      scope: { mode: 'all' },
      versionPolicy: 'track',
      pinnedVersion: null,
      updatedAt: T0,
      updatedBy: 'dev-a',
    })
    expect(parsed?.baseCommit).toBeNull()
    expect(parsed?.removed).toEqual([])
    expect(parsed?.skills).toEqual({})
    expect(parsed?.status).toEqual({
      lastSyncAt: null,
      lastResult: 'ok',
      lastError: null,
      pendingActivation: [],
    })
    expect(parsed).not.toHaveProperty('ignoredTopLevelKey')
  })

  it('never throws on hostile input', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('boom')
        },
      },
    )
    expect(parseManifestV2(hostile)).toBeNull()
    expect(parsePolicyV2(hostile, PROFILE)).toBeNull()
    expect(parseDeviceManifestV2(hostile)).toBeNull()
  })
})

describe('mergeDesired: basic declarations', () => {
  it('resolves a single device declaration', () => {
    const result = merge([deviceManifest('dev-a', { alpha: pluginEntry() })])
    expect(result).toEqual({
      plugins: {
        alpha: {
          id: 'alpha',
          version: '1.0.0',
          enabled: true,
          installSpec: 'alpha@1.0.0',
          origin: 'npm',
          syncable: true,
          pinned: false,
          versionPolicy: 'track',
          sources: ['dev-a'],
          updatedAt: T0,
          updatedBy: 'dev-a',
        },
      },
      removals: [],
      conflicts: [],
      blocked: [],
      warnings: [],
    })
  })

  it('skips entries that are not syncable', () => {
    const result = merge([
      deviceManifest('dev-a', {
        alpha: pluginEntry({ id: 'alpha', syncable: false, origin: 'local' }),
        beta: pluginEntry({ id: 'beta' }),
      }),
    ])
    expect(Object.keys(result.plugins)).toEqual(['beta'])
    expect(result.warnings).toEqual([])
  })

  it('picks the highest tracked version across devices', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: '1.0.0', updatedAt: T0 }) }),
      deviceManifest('dev-b', {
        alpha: pluginEntry({ version: '2.1.0', installSpec: 'alpha@2.1.0', updatedAt: T1, updatedBy: 'dev-b' }),
      }),
    ])
    expect(result.plugins['alpha']).toEqual({
      id: 'alpha',
      version: '2.1.0',
      enabled: true,
      installSpec: 'alpha@2.1.0',
      origin: 'npm',
      syncable: true,
      pinned: false,
      versionPolicy: 'track',
      sources: ['dev-b'],
      updatedAt: T1,
      updatedBy: 'dev-b',
    })
  })

  it('takes enabled from the last writer but metadata from the version supplier', () => {
    const result = merge([
      deviceManifest('dev-a', {
        alpha: pluginEntry({ version: '1.0.0', enabled: true, updatedAt: T2, updatedBy: 'dev-a' }),
      }),
      deviceManifest('dev-b', {
        alpha: pluginEntry({
          version: '2.0.0',
          enabled: false,
          installSpec: 'alpha@custom-build',
          updatedAt: T1,
          updatedBy: 'dev-b',
        }),
      }),
    ])
    expect(result.plugins['alpha']).toEqual({
      id: 'alpha',
      version: '2.0.0',
      enabled: true,
      installSpec: 'alpha@custom-build',
      origin: 'npm',
      syncable: true,
      pinned: false,
      versionPolicy: 'track',
      sources: ['dev-b'],
      updatedAt: T1,
      updatedBy: 'dev-b',
    })
  })

  it('breaks enabled ties by the device id that sorts last', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ enabled: false, updatedAt: T0 }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ enabled: true, updatedAt: T0, updatedBy: 'dev-b' }) }),
    ])
    expect(result.plugins['alpha']?.enabled).toBe(true)
    expect(result.plugins['alpha']?.updatedBy).toBe('dev-b')
  })
})

describe('mergeDesired: scope filtering', () => {
  it('ignores declarations scoped to another device', () => {
    const scoped = pluginEntry({ scope: { mode: 'devices', devices: ['dev-b'] } })
    const result = merge([deviceManifest('dev-b', { alpha: scoped })], { selfId: 'dev-a' })
    expect(result.plugins).toEqual({})
    expect(result.conflicts).toEqual([])
  })

  it('applies declarations whose scope lists this device', () => {
    const scoped = pluginEntry({ scope: { mode: 'devices', devices: ['dev-a', 'dev-b'] } })
    const result = merge([deviceManifest('dev-b', { alpha: scoped })])
    expect(result.plugins['alpha']?.version).toBe('1.0.0')
    expect(result.plugins['alpha']?.sources).toEqual(['dev-b'])
  })
})

describe('mergeDesired: version policies', () => {
  it('lets a pin win over a newer tracked version', () => {
    const result = merge([
      deviceManifest('dev-a', {
        alpha: pluginEntry({ version: '1.5.0', versionPolicy: 'pin', pinnedVersion: '1.5.0', updatedAt: T0 }),
      }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: '2.0.0', updatedAt: T1, updatedBy: 'dev-b' }) }),
    ])
    expect(result.plugins['alpha']).toEqual({
      id: 'alpha',
      version: '1.5.0',
      enabled: true,
      installSpec: 'alpha@1.5.0',
      origin: 'npm',
      syncable: true,
      pinned: true,
      versionPolicy: 'pin',
      sources: ['dev-a'],
      updatedAt: T0,
      updatedBy: 'dev-a',
    })
  })

  it('merges two devices that pin the same version', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: '1.5.0', versionPolicy: 'pin', pinnedVersion: '1.5.0' }) }),
      deviceManifest('dev-b', {
        alpha: pluginEntry({
          version: '1.5.0',
          versionPolicy: 'pin',
          pinnedVersion: '1.5.0',
          updatedAt: T1,
          updatedBy: 'dev-b',
        }),
      }),
    ])
    expect(result.plugins['alpha']?.pinned).toBe(true)
    expect(result.plugins['alpha']?.sources).toEqual(['dev-a', 'dev-b'])
    expect(result.plugins['alpha']?.updatedBy).toBe('dev-b')
  })

  it('reports conflicting pins and installs nothing for that plugin', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: '2.0.0', versionPolicy: 'pin', pinnedVersion: '2.0.0' }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: '1.0.0', versionPolicy: 'pin', pinnedVersion: '1.0.0' }) }),
    ])
    expect(result.plugins).toEqual({})
    expect(result.conflicts).toEqual([
      {
        pluginId: 'alpha',
        reason: 'pin-mismatch',
        detail: expect.stringContaining('alpha'),
        versions: ['1.0.0', '2.0.0'],
      },
    ])
  })

  it('ignores null tracked versions and reports when no version is usable', () => {
    const withFallback = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: null }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: '3.0.0', updatedAt: T1, updatedBy: 'dev-b' }) }),
    ])
    expect(withFallback.plugins['alpha']?.version).toBe('3.0.0')
    expect(withFallback.plugins['alpha']?.sources).toEqual(['dev-b'])

    const noVersion = merge([deviceManifest('dev-a', { alpha: pluginEntry({ version: null }) })])
    expect(noVersion.plugins).toEqual({})
    expect(noVersion.conflicts).toEqual([
      { pluginId: 'alpha', reason: 'no-version', detail: expect.stringContaining('alpha'), versions: [] },
    ])
  })

  it('prefers stable versions over prereleases by default', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: '1.0.0', updatedAt: T0 }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: '2.0.0-beta.1', updatedAt: T1, updatedBy: 'dev-b' }) }),
    ])
    expect(result.plugins['alpha']?.version).toBe('1.0.0')
    expect(result.plugins['alpha']?.sources).toEqual(['dev-a'])
  })

  it('reports a conflict when only prereleases are declared', () => {
    const result = merge([deviceManifest('dev-a', { alpha: pluginEntry({ version: '2.0.0-beta.1' }) })])
    expect(result.plugins).toEqual({})
    expect(result.conflicts).toEqual([
      {
        pluginId: 'alpha',
        reason: 'no-version',
        detail: expect.stringContaining('prerelease'),
        versions: ['2.0.0-beta.1'],
      },
    ])
  })

  it('allows prereleases when the policy opts in', () => {
    const result = merge(
      [
        deviceManifest('dev-a', { alpha: pluginEntry({ version: '1.0.0', updatedAt: T0 }) }),
        deviceManifest('dev-b', { alpha: pluginEntry({ version: '2.0.0-beta.1', updatedAt: T1, updatedBy: 'dev-b' }) }),
      ],
      { policy: policyWith({ allowPrerelease: true }) },
    )
    expect(result.plugins['alpha']?.version).toBe('2.0.0-beta.1')
    expect(result.plugins['alpha']?.sources).toEqual(['dev-b'])
  })

  it('honors a pinned prerelease even when allowPrerelease is false', () => {
    const result = merge([
      deviceManifest('dev-a', {
        alpha: pluginEntry({ version: '2.0.0-beta.1', versionPolicy: 'pin', pinnedVersion: '2.0.0-beta.1' }),
      }),
    ])
    expect(result.plugins['alpha']?.version).toBe('2.0.0-beta.1')
    expect(result.plugins['alpha']?.pinned).toBe(true)
  })

  it('falls back to the last writer for unparsable versions', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: 'nightlyA', updatedAt: T1 }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: 'nightlyB', updatedAt: T0, updatedBy: 'dev-b' }) }),
    ])
    expect(result.plugins['alpha']?.version).toBe('nightlyA')
    expect(result.plugins['alpha']?.sources).toEqual(['dev-a'])
  })

  it('prefers a parsable version over an unparsable one', () => {
    const result = merge([
      deviceManifest('dev-a', { alpha: pluginEntry({ version: '1.2.0', updatedAt: T0 }) }),
      deviceManifest('dev-b', { alpha: pluginEntry({ version: 'nightly', updatedAt: T1, updatedBy: 'dev-b' }) }),
    ])
    expect(result.plugins['alpha']?.version).toBe('1.2.0')
  })
})

describe('mergeDesired: deletions', () => {
  it('propagates removals that no device declares', () => {
    const result = merge([
      deviceManifest('dev-a', {}, { removed: [{ id: 'beta', at: T1 }] }),
      deviceManifest('dev-b', {}, { removed: [{ id: 'alpha', at: T2 }] }),
    ])
    expect(result.removals).toEqual(['alpha', 'beta'])
    expect(result.plugins).toEqual({})
    expect(result.warnings).toEqual([])
    expect(result.conflicts).toEqual([])
  })

  it('does not propagate removals when deletion.propagate is false', () => {
    const result = merge(
      [deviceManifest('dev-a', {}, { removed: [{ id: 'alpha', at: T1 }] })],
      { policy: policyWith({ propagate: false }) },
    )
    expect(result.removals).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('deletion.propagate is false')
  })

  it('reports deleted-while-declared as a conflict instead of installing or removing it', () => {
    const result = merge([
      deviceManifest('dev-a', {}, { removed: [{ id: 'alpha', at: T1 }] }),
      deviceManifest('dev-b', { alpha: pluginEntry() }),
    ])
    expect(result.plugins).toEqual({})
    expect(result.removals).toEqual([])
    expect(result.conflicts).toEqual([
      { pluginId: 'alpha', reason: 'deleted-while-declared', detail: expect.stringContaining('alpha'), versions: [] },
    ])
  })

  it('only warns about deleted-while-declared when not propagating', () => {
    const result = merge(
      [
        deviceManifest('dev-a', {}, { removed: [{ id: 'alpha', at: T1 }] }),
        deviceManifest('dev-b', { alpha: pluginEntry() }),
      ],
      { policy: policyWith({ propagate: false }) },
    )
    expect(result.plugins).toEqual({})
    expect(result.removals).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('deletion.propagate is false')
  })

  it('ignores declarations that are out of scope when checking deletions', () => {
    const scoped = pluginEntry({ scope: { mode: 'devices', devices: ['dev-b'] } })
    const result = merge([
      deviceManifest('dev-b', { alpha: scoped }, { removed: [{ id: 'alpha', at: T1 }] }),
    ])
    expect(result.removals).toEqual(['alpha'])
    expect(result.conflicts).toEqual([])
  })

  it('treats a non-syncable declaration as still declared', () => {
    const result = merge([
      deviceManifest('dev-a', {}, { removed: [{ id: 'alpha', at: T1 }] }),
      deviceManifest('dev-b', { alpha: pluginEntry({ syncable: false }) }),
    ])
    expect(result.removals).toEqual([])
    expect(result.conflicts).toEqual([
      { pluginId: 'alpha', reason: 'deleted-while-declared', detail: expect.stringContaining('alpha'), versions: [] },
    ])
  })
})

describe('mergeDesired: minimum DSH version', () => {
  it('blocks every syncable plugin when the local DSH version is too old', () => {
    const result = merge(
      [
        deviceManifest('dev-a', {
          alpha: pluginEntry({ id: 'alpha' }),
          zeta: pluginEntry({ id: 'zeta' }),
          gamma: pluginEntry({ id: 'gamma', syncable: false }),
        }),
      ],
      { localDshVersion: '0.2.1' },
    )
    expect(result.plugins).toEqual({})
    expect(result.removals).toEqual([])
    expect(result.blocked).toEqual([
      { pluginId: 'alpha', reason: 'min-dsh-version' },
      { pluginId: 'zeta', reason: 'min-dsh-version' },
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('0.2.1')
    expect(result.warnings[0]).toContain('0.2.2')
  })

  it('accepts a prerelease of the minimum core version', () => {
    const result = merge([deviceManifest('dev-a', { alpha: pluginEntry() })], {
      localDshVersion: '0.2.2-rc.5',
    })
    expect(result.blocked).toEqual([])
    expect(result.plugins['alpha']?.version).toBe('1.0.0')
  })

  it('does not block when the local version has a v prefix or is unparsable', () => {
    const devices = [deviceManifest('dev-a', { alpha: pluginEntry() })]
    const prefixed = merge(devices, { localDshVersion: 'v0.2.3' })
    expect(prefixed.blocked).toEqual([])
    expect(prefixed.plugins['alpha']?.version).toBe('1.0.0')

    const unparsable = merge(devices, { localDshVersion: 'nightly-build' })
    expect(unparsable.blocked).toEqual([])
    expect(unparsable.plugins['alpha']?.version).toBe('1.0.0')
  })

  it('does not process deletions when the device is blocked', () => {
    const result = merge(
      [deviceManifest('dev-a', {}, { removed: [{ id: 'alpha', at: T1 }] })],
      { localDshVersion: '0.2.1' },
    )
    expect(result.removals).toEqual([])
    expect(result.blocked).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })
})

describe('mergeDesired: determinism', () => {
  it('produces identical output for reordered input', () => {
    const alphaA = pluginEntry({ id: 'alpha', version: '1.0.0', updatedAt: T0 })
    const betaA = pluginEntry({ id: 'beta', version: '1.0.0', updatedAt: T0 })
    const alphaB = pluginEntry({ id: 'alpha', version: '2.0.0', updatedAt: T1, updatedBy: 'dev-b' })

    const first = merge([
      deviceManifest('dev-a', { alpha: alphaA, beta: betaA }),
      deviceManifest('dev-b', { alpha: alphaB }),
    ])
    const second = merge([
      deviceManifest('dev-b', { alpha: alphaB }),
      deviceManifest('dev-a', { beta: betaA, alpha: alphaA }),
    ])
    expect(second).toEqual(first)
    expect(Object.keys(first.plugins)).toEqual(['alpha', 'beta'])
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('sorts diagnostics and removals', () => {
    const result = merge([
      deviceManifest('dev-a', {
        zeta: pluginEntry({ id: 'zeta', version: '1.0.0', versionPolicy: 'pin', pinnedVersion: '2.0.0' }),
        alpha: pluginEntry({ id: 'alpha', version: '1.0.0', versionPolicy: 'pin', pinnedVersion: '3.0.0' }),
      }),
      deviceManifest('dev-b', {
        zeta: pluginEntry({ id: 'zeta', version: '1.0.0', versionPolicy: 'pin', pinnedVersion: '1.0.0' }),
        alpha: pluginEntry({ id: 'alpha', version: '1.0.0', versionPolicy: 'pin', pinnedVersion: '1.0.0' }),
      }, {
        removed: [{ id: 'omega', at: T1 }, { id: 'beta', at: T1 }],
      }),
    ])
    expect(result.conflicts.map(conflict => conflict.pluginId)).toEqual(['alpha', 'zeta'])
    expect(result.removals).toEqual(['beta', 'omega'])
  })
})
