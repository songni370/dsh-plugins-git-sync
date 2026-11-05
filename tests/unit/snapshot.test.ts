/**
 * Unit tests for local safety snapshots.
 *
 * Retention keeps the newest snapshots so a long-lived installation does not
 * accumulate files forever. It must never fail the backup that just succeeded.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSnapshotService } from '../../src/services/snapshot.js'
import type { DeviceInfo, DeviceInventory } from '../../src/types.js'

const device: DeviceInfo = {
  id: 'device-1',
  name: 'test',
  platform: 'darwin',
  arch: 'arm64',
  dshVersion: '0.2.1',
  pluginVersion: '0.2.10',
}

const inventory: DeviceInventory = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  profile: 'desktop',
  device,
  plugins: [],
}

describe('snapshot retention', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dgs-snapshots-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps only the configured number of snapshots', async () => {
    const service = createSnapshotService({ snapshotDir: dir, keep: 3 })
    for (let index = 0; index < 5; index += 1) {
      await service.create({ operation: 'sync', profile: 'desktop', device, inventory, configs: {} })
    }
    const entries = await readdir(dir)
    expect(entries).toHaveLength(3)
    expect(await service.list()).toHaveLength(3)
  })

  it('never prunes the snapshot that was just written', async () => {
    const service = createSnapshotService({ snapshotDir: dir, keep: 1 })
    const first = await service.create({ operation: 'sync', profile: 'desktop', device, inventory, configs: {} })
    const second = await service.create({ operation: 'sync', profile: 'desktop', device, inventory, configs: {} })
    expect(await service.list()).toEqual([second])
    expect(await readdir(dir)).not.toContain(first)
  })
})
