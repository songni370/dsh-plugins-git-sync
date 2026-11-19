/**
 * Unit tests for the v2 repository bridge: building the files of a commit,
 * including the one-time v1 -> v2 migration marker.
 * @module tests/unit/repo-v2-bridge
 */

import { describe, expect, it } from 'vitest'
import {
  buildV2RepoFiles,
  type LegacyDeviceRecord,
} from '../../src/services/repo-v2-bridge.js'
import {
  deviceManifestPath,
  manifestPath,
  parseManifestV2,
  policyPath,
  type DeviceManifestV2,
} from '../../src/services/repo-v2.js'

const T1 = '2026-11-19T00:00:00.000Z'
const PROFILE = 'desktop'

function selfManifest(): DeviceManifestV2 {
  return {
    schemaVersion: 2,
    device: {
      id: 'dev-self',
      name: 'self',
      platform: 'darwin',
      arch: 'arm64',
      dshVersion: '0.2.2-rc.5',
      pluginVersion: '0.3.0',
    },
    profile: PROFILE,
    updatedAt: T1,
    baseCommit: null,
    plugins: {},
    removed: [],
    skills: {},
    status: { lastSyncAt: null, lastResult: 'ok', lastError: null, pendingActivation: [] },
  }
}

const legacyDevice: LegacyDeviceRecord = {
  device: {
    id: 'dev-old',
    name: 'old',
    platform: 'win32',
    arch: 'x64',
    dshVersion: '0.2.1',
    pluginVersion: '0.2.13',
  },
  updatedAt: T1,
}

describe('buildV2RepoFiles', () => {
  it('writes a fresh manifest without a migration marker', () => {
    const files = buildV2RepoFiles({
      read: null,
      selfManifest: selfManifest(),
      profile: PROFILE,
      pluginVersion: '0.3.0',
      now: T1,
    })
    const manifest = parseManifestV2(JSON.parse(files[manifestPath] ?? ''))
    expect(manifest).not.toBeNull()
    expect(manifest?.schemaVersion).toBe(2)
    expect(manifest?.migratedFrom).toBeUndefined()
    expect(files[policyPath(PROFILE)]).toBeDefined()
    expect(files[deviceManifestPath('dev-self', PROFILE)]).toBeDefined()
  })

  it('marks a repository migrated from v1 and records legacy devices', () => {
    const files = buildV2RepoFiles({
      read: null,
      selfManifest: selfManifest(),
      profile: PROFILE,
      pluginVersion: '0.3.0',
      now: T1,
      legacyDevices: { 'dev-old': legacyDevice },
    })
    const manifest = parseManifestV2(JSON.parse(files[manifestPath] ?? ''))
    expect(manifest?.migratedFrom).toBe(1)
    expect(manifest?.devices.map(record => record.id).sort()).toEqual(['dev-old', 'dev-self'])
  })
})

describe('buildOwnDeviceManifest', () => {
  it('preserves an explicit enabled override from the previous manifest', async () => {
    const { buildOwnDeviceManifest } = await import('../../src/services/repo-v2-bridge.js')
    const previous = selfManifest()
    previous.plugins['alpha'] = {
      id: 'alpha',
      version: '1.0.0',
      enabled: true,
      enabledOverride: false,
      installSpec: 'alpha@1.0.0',
      origin: 'npm',
      syncable: true,
      scope: { mode: 'all' },
      versionPolicy: 'track',
      pinnedVersion: null,
      updatedAt: T1,
      updatedBy: 'dev-self',
    }
    const inventory = {
      schemaVersion: 1,
      generatedAt: T1,
      profile: PROFILE,
      device: { ...previous.device, id: 'dev-self' },
      plugins: [
        {
          id: 'alpha',
          name: 'alpha',
          version: '1.0.0',
          origin: 'npm' as const,
          installSpec: 'alpha@1.0.0',
          enabled: true,
          builtIn: false,
          syncable: true,
          pathOnly: false,
          profile: PROFILE,
          platform: 'darwin',
          rows: [],
          configs: {},
          configSkipped: [],
        },
      ],
    }
    const built = buildOwnDeviceManifest({ previous, inventory, profile: PROFILE, now: T1 })
    expect(built.plugins['alpha']?.enabledOverride).toBe(false)
  })
})
