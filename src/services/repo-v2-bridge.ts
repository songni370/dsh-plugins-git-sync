/**
 * Bridge between the v2 repository model (`repo-v2.ts`) and the sync engine.
 *
 * Responsibilities:
 * - read the v2 layout (`manifest.json` + `policies/<profile>.json` +
 *   `devices/<id>/<profile>.json`) from a prepared work tree;
 * - merge every device's declaration into this device's desired state;
 * - expose the desired state as the existing `RemoteProfileState` so the
 *   v1 planners keep working unchanged;
 * - build this device's own v2 manifest and the files for the next commit,
 *   including the one-time v1 -> v2 migration.
 *
 * The module is pure apart from the small store interface passed in.
 */

import {
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
  type DesiredMergeV2,
  type DeviceManifestV2,
  type DevicePendingActivationV2,
  type DevicePluginEntryV2,
  type DeviceStatusV2,
  type RepoDeviceRecordV2,
  type RepoManifestV2,
  type RepoPolicyV2,
} from './repo-v2.js'
import type {
  ConflictInfo,
  DeviceInfo,
  DeviceInventory,
  PluginOrigin,
  PluginRecord,
  RemotePluginEntry,
  RemoteProfileState,
} from '../types.js'

/** The subset of `RepoStore` the v2 bridge needs. */
export interface RepoV2Store {
  readRepoText(relative: string): Promise<string | null>
  listRepoPath(relative: string): Promise<Array<{ name: string; directory: boolean }> | null>
}

/** Everything read from a v2 repository for one profile. */
export interface RepoV2Read {
  manifest: RepoManifestV2
  policy: RepoPolicyV2
  devices: DeviceManifestV2[]
  byId: Record<string, DeviceManifestV2>
  desired: DesiredMergeV2
}

/** Parse one JSON document without throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The repository schema version, or null when there is no readable manifest. */
export async function detectRepoSchemaVersion(store: RepoV2Store): Promise<number | null> {
  const text = await store.readRepoText(manifestPath)
  if (text === null) return null
  const parsed = parseJson(text)
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = (parsed as { schemaVersion?: unknown }).schemaVersion
  return typeof value === 'number' ? value : null
}

/** Read and merge the v2 repository. Returns null when it is not a v2 repository. */
export async function readV2State(
  store: RepoV2Store,
  profile: string,
  selfId: string,
  localDshVersion: string,
): Promise<RepoV2Read | null> {
  const text = await store.readRepoText(manifestPath)
  if (text === null) return null
  const manifest = parseManifestV2(parseJson(text))
  if (manifest === null) return null

  const policyText = await store.readRepoText(policyPath(profile))
  const policy = policyText === null ? null : parsePolicyV2(parseJson(policyText), profile)

  const devices: DeviceManifestV2[] = []
  const directories = await store.listRepoPath('devices')
  if (directories !== null) {
    const sorted = directories.filter(entry => entry.directory).sort((a, b) => a.name.localeCompare(b.name))
    for (const directory of sorted) {
      const raw = await store.readRepoText(deviceManifestPath(directory.name, profile))
      if (raw === null) continue
      const device = parseDeviceManifestV2(parseJson(raw))
      if (device === null || device.device.id !== directory.name) continue
      devices.push(device)
    }
  }

  const effectivePolicy = policy ?? defaultPolicy(profile)
  const desired = mergeDesired({ selfId, policy: effectivePolicy, devices, localDshVersion })
  const byId: Record<string, DeviceManifestV2> = {}
  for (const device of devices) byId[device.device.id] = device
  return { manifest, policy: effectivePolicy, devices, byId, desired }
}

/** Project the merged desired state onto the v1 `RemoteProfileState` shape. */
export function desiredRemoteState(
  read: RepoV2Read,
  profile: string,
  now: string,
): RemoteProfileState {
  const plugins: Record<string, RemotePluginEntry> = {}
  for (const [id, plugin] of Object.entries(read.desired.plugins).sort(([a], [b]) => a.localeCompare(b))) {
    plugins[id] = {
      id,
      name: id,
      version: plugin.version,
      origin: plugin.origin as PluginOrigin,
      installSpec: plugin.installSpec,
      enabled: plugin.enabled,
      builtIn: false,
      syncable: plugin.syncable,
      pathOnly: false,
      rows: [],
      updatedAt: plugin.updatedAt,
      updatedBy: plugin.updatedBy,
    }
  }
  return {
    schemaVersion: 2,
    profile,
    updatedAt: now,
    plugins,
  }
}

/** Convert merge conflicts into the planners' `ConflictInfo` shape. */
export function desiredConflicts(read: RepoV2Read, local: Readonly<Record<string, PluginRecord>>): ConflictInfo[] {
  return read.desired.conflicts.map(conflict => {
    const plugin = local[conflict.pluginId]
    const fields = conflict.reason === 'pin-mismatch' ? ['version'] : conflict.reason === 'deleted-while-declared' ? ['presence'] : ['version']
    return {
      id: `conflict:${conflict.pluginId}`,
      pluginId: conflict.pluginId,
      pluginName: plugin?.name ?? conflict.pluginId,
      reason: conflict.reason,
      fields,
      localVersion: plugin?.version ?? null,
      remoteVersion: conflict.versions[0] ?? null,
      localEnabled: plugin?.enabled ?? null,
      remoteEnabled: null,
      localConfig: plugin?.configs,
      hadBaseline: undefined,
    }
  })
}

/** Input for building this device's own v2 manifest after a successful run. */
export interface OwnDeviceManifestInput {
  previous: DeviceManifestV2 | null
  inventory: DeviceInventory
  /** Fresh successful scan after local actions; defaults to `inventory`. */
  after?: DeviceInventory
  profile: string
  now: string
  /** Plugins explicitly removed by this run (repository deletions propagated here). */
  explicitRemovals?: ReadonlySet<string>
  /** Plugins whose install failed; never record these as deliberate removals. */
  protectedIds?: ReadonlySet<string>
  pendingActivation?: readonly DevicePendingActivationV2[]
  lastResult?: DeviceStatusV2['lastResult']
  lastError?: string | null
  baseCommit?: string | null
}

/** Build this device's declaration for the repository. */
export function buildOwnDeviceManifest(input: OwnDeviceManifestInput): DeviceManifestV2 {
  const device = input.inventory.device
  const after = input.after ?? input.inventory
  const previous = input.previous
  const current = new Map<string, PluginRecord>()
  for (const plugin of after.plugins) {
    if (plugin.builtIn || !plugin.syncable) continue
    current.set(plugin.id, plugin)
  }

  const plugins: Record<string, DevicePluginEntryV2> = {}
  for (const [id, plugin] of [...current.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const old = previous?.plugins[id]
    plugins[id] = {
      id,
      version: plugin.version,
      enabled: plugin.enabled,
      ...(old?.enabledOverride === undefined ? {} : { enabledOverride: old.enabledOverride }),
      installSpec: plugin.installSpec,
      origin: plugin.origin,
      syncable: plugin.syncable,
      scope: old?.scope ?? { mode: 'all' },
      versionPolicy: old?.versionPolicy ?? 'track',
      pinnedVersion: old?.pinnedVersion ?? null,
      updatedAt: input.now,
      updatedBy: device.id,
    }
  }

  const previousPlugins = previous?.plugins ?? {}
  const removed: DeviceManifestV2['removed'] = [...(previous?.removed ?? [])]
  const knownRemoved = new Set(removed.map(entry => entry.id))
  const candidates = new Set<string>(input.explicitRemovals ?? [])
  for (const id of Object.keys(previousPlugins)) candidates.add(id)
  for (const id of [...candidates].sort()) {
    if (current.has(id)) continue
    if (input.protectedIds?.has(id) === true) continue
    if (knownRemoved.has(id)) continue
    const name = previousPlugins[id]?.id ?? id
    removed.push({ id, at: input.now, name })
    knownRemoved.add(id)
  }
  // A plugin that is declared again is no longer pending deletion.
  const pruned = removed.filter(entry => !current.has(entry.id))

  const status: DeviceStatusV2 = {
    lastSyncAt: input.now,
    lastResult: input.lastResult ?? 'ok',
    lastError: input.lastError ?? null,
    pendingActivation: [...(input.pendingActivation ?? [])],
  }

  return {
    schemaVersion: 2,
    device: {
      id: device.id,
      name: device.name,
      platform: device.platform,
      arch: device.arch,
      dshVersion: device.dshVersion,
      pluginVersion: device.pluginVersion,
    },
    profile: input.profile,
    updatedAt: input.now,
    baseCommit: input.baseCommit ?? null,
    plugins,
    removed: pruned,
    skills: previous?.skills ?? {},
    status,
  }
}

/** Device record derived from the current device. */
function deviceRecord(device: DeviceManifestV2, lastCommit: string | null): RepoDeviceRecordV2 {
  return {
    id: device.device.id,
    name: device.device.name,
    platform: device.device.platform,
    arch: device.device.arch,
    dshVersion: device.device.dshVersion,
    pluginVersion: device.device.pluginVersion,
    lastSyncAt: device.status.lastSyncAt,
    lastCommit,
    updatedAt: device.updatedAt,
    lastResult: device.status.lastResult,
  }
}

/** One legacy device snapshot, used when migrating a v1 repository. */
export interface LegacyDeviceRecord {
  device: DeviceInfo
  updatedAt: string
}

/** Input for building the v2 files of one commit. */
export interface BuildV2FilesInput {
  /** Existing v2 state; null when creating or migrating the repository. */
  read: RepoV2Read | null
  selfManifest: DeviceManifestV2
  profile: string
  pluginVersion: string
  now: string
  legacyDevices?: Readonly<Record<string, LegacyDeviceRecord>>
  commit?: string | null
}

/** Files to add to the next backup commit, keyed by repository-relative path. */
export function buildV2RepoFiles(input: BuildV2FilesInput): Record<string, string> {
  const { selfManifest, profile, now } = input
  const selfId = selfManifest.device.id
  const existingDevices = new Map<string, RepoDeviceRecordV2>()
  for (const record of input.read?.manifest.devices ?? []) existingDevices.set(record.id, record)
  for (const [id, legacy] of Object.entries(input.legacyDevices ?? {})) {
    if (existingDevices.has(id)) continue
    existingDevices.set(id, {
      id,
      name: legacy.device.name,
      platform: legacy.device.platform,
      arch: legacy.device.arch,
      dshVersion: legacy.device.dshVersion,
      pluginVersion: legacy.device.pluginVersion,
      lastSyncAt: null,
      lastCommit: null,
      updatedAt: legacy.updatedAt,
      lastResult: 'ok',
    })
  }
  existingDevices.set(selfId, deviceRecord(selfManifest, input.commit ?? null))
  const devices = [...existingDevices.values()].sort((a, b) => a.id.localeCompare(b.id))

  const pluginCount = Object.keys(selfManifest.plugins).length
  const migratedFrom = input.read === null && Object.keys(input.legacyDevices ?? {}).length > 0
  const manifest: RepoManifestV2 = {
    schemaVersion: 2,
    generator: { name: 'dsh-plugins-git-sync', version: input.pluginVersion },
    ...(migratedFrom
      ? { migratedFrom: 1 }
      : input.read?.manifest.migratedFrom === undefined
        ? {}
        : { migratedFrom: input.read.manifest.migratedFrom }),
    profiles: {
      ...(input.read?.manifest.profiles ?? {}),
      [profile]: { pluginCount },
    },
    devices,
    updatedAt: now,
  }
  const policy = input.read?.policy ?? defaultPolicy(profile)

  return {
    [manifestPath]: serializeManifestV2(manifest),
    [policyPath(profile)]: serializePolicyV2(policy),
    [deviceManifestPath(selfId, profile)]: serializeDeviceManifestV2(selfManifest),
  }
}

/** Read the pending activations recorded in this device's previous manifest. */
export function previousPendingActivation(previous: DeviceManifestV2 | null): DevicePendingActivationV2[] {
  return previous === null ? [] : [...previous.status.pendingActivation]
}
