/**
 * Pure v2 repository model: document types, validation, deterministic
 * serialization, and the desired-state merge used by the multi-device
 * reconciler.
 *
 * This module has no filesystem or Git access on purpose: the sync engine reads
 * and writes the work tree, then hands untrusted JSON to the parsers here. The
 * merge therefore stays a pure function that can be unit-tested in isolation.
 *
 * Repository layout (see `docs/MULTI_DEVICE_SYNC.md` §3):
 *   manifest.json
 *   policies/<profile>.json
 *   devices/<deviceId>/<profile>.json
 * @module services/repo-v2
 */

import { compareVersions, parseVersion } from '../core/version.js'

/** Format version written into every v2 document. */
export const REPO_SCHEMA_VERSION = 2

/** Which devices a plugin declaration applies to. */
export interface PluginScopeV2 {
  mode: 'all' | 'devices'
  devices?: string[]
}

/** How a device follows versions for one plugin. */
export type PluginVersionPolicyV2 = 'track' | 'pin'

/** One plugin declaration inside a device manifest. */
export interface DevicePluginEntryV2 {
  id: string
  version: string | null
  enabled: boolean
  /**
   * Explicit per-device override for the desired enabled state. When this
   * device declares it, it wins over the last-writer-wins result for this
   * device only; other devices keep merging normally.
   */
  enabledOverride?: boolean
  installSpec: string | null
  origin: string
  syncable: boolean
  scope: PluginScopeV2
  versionPolicy: PluginVersionPolicyV2
  pinnedVersion: string | null
  updatedAt: string
  updatedBy: string
}

/** One explicit deletion intent recorded by a device. */
export interface DeviceRemovalV2 {
  id: string
  at: string
  name?: string
}

/** One skill directory recorded by a device manifest. */
export interface DeviceSkillEntryV2 {
  name: string
  hash: string
  files: number
  updatedAt: string
  deleted?: boolean
}

/** One plugin that is installed but not active until DSH restarts. */
export interface DevicePendingActivationV2 {
  pluginId: string
  version: string
  reason: string
}

/** Per-device synchronization status, visible to every other device. */
export interface DeviceStatusV2 {
  lastSyncAt: string | null
  lastResult: 'ok' | 'no-changes' | 'conflict' | 'error' | 'blocked' | 'pending'
  lastError: string | null
  pendingActivation: DevicePendingActivationV2[]
}

/** `devices/<deviceId>/<profile>.json`: one device's declared expected state. */
export interface DeviceManifestV2 {
  schemaVersion: 2
  device: {
    id: string
    name: string
    platform: string
    arch: string
    dshVersion: string
    pluginVersion: string
  }
  profile: string
  updatedAt: string
  baseCommit: string | null
  plugins: Record<string, DevicePluginEntryV2>
  removed: DeviceRemovalV2[]
  skills: Record<string, DeviceSkillEntryV2>
  status: DeviceStatusV2
}

/** One device row in the root manifest. */
export interface RepoDeviceRecordV2 {
  id: string
  name: string
  platform: string
  arch: string
  dshVersion: string
  pluginVersion: string
  lastSyncAt: string | null
  lastCommit: string | null
  updatedAt: string
  lastResult?: string
}

/** `manifest.json`: the repository index. */
export interface RepoManifestV2 {
  schemaVersion: 2
  generator: { name: string; version: string }
  migratedFrom?: number
  profiles: Record<string, { pluginCount: number }>
  devices: RepoDeviceRecordV2[]
  updatedAt: string
}

/** `policies/<profile>.json`: the shared default policy for one profile. */
export interface RepoPolicyV2 {
  schemaVersion: 2
  profile: string
  sync: {
    mode: 'two-way' | 'backup' | 'restore'
    auto: { enabled: boolean; apply: 'safe' | 'all'; onStartup: boolean; onPluginChange: boolean }
  }
  deletion: { propagate: boolean }
  versions: { default: 'track'; downgrade: 'confirm' | 'allow' | 'block'; allowPrerelease: boolean }
  scope: { default: 'all' }
  minDshVersion: string
  backupButton: { warnWhenMultiDevice: boolean }
}

/** The policy a fresh v2 repository starts with. */
export const defaultPolicy = (profile: string): RepoPolicyV2 => ({
  schemaVersion: 2,
  profile,
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

/** Path of the root manifest. */
export const manifestPath = 'manifest.json'

/** Path of one profile's policy document. */
export const policyPath = (profile: string): string => `policies/${profile}.json`

/** Path of one device's manifest for one profile. */
export const deviceManifestPath = (deviceId: string, profile: string): string =>
  `devices/${deviceId}/${profile}.json`

// ---------------------------------------------------------------------------
// Untrusted JSON helpers
// ---------------------------------------------------------------------------

/** Result of reading one field from an untrusted value. */
type FieldRead<T> = { ok: true; value: T } | { ok: false }

/** Whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const fieldMissing: FieldRead<never> = { ok: false }

/** Read a required string. */
function fieldString(record: Record<string, unknown>, key: string): FieldRead<string> {
  const value = record[key]
  return typeof value === 'string' ? { ok: true, value } : fieldMissing
}

/** Read a nullable string; absent and null mean "no value". */
function fieldNullableString(record: Record<string, unknown>, key: string): FieldRead<string | null> {
  const value = record[key]
  if (value === undefined || value === null) return { ok: true, value: null }
  return typeof value === 'string' ? { ok: true, value } : fieldMissing
}

/** Read a required boolean. */
function fieldBoolean(record: Record<string, unknown>, key: string): FieldRead<boolean> {
  const value = record[key]
  return typeof value === 'boolean' ? { ok: true, value } : fieldMissing
}

/** Read an optional boolean; absent means "no explicit value". */
function fieldOptionalBoolean(record: Record<string, unknown>, key: string): FieldRead<boolean | undefined> {
  const value = record[key]
  if (value === undefined) return { ok: true, value: undefined }
  return typeof value === 'boolean' ? { ok: true, value } : fieldMissing
}

/** Read a required finite number. */
function fieldNumber(record: Record<string, unknown>, key: string): FieldRead<number> {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : fieldMissing
}

/** Read a required JSON object. */
function fieldRecord(record: Record<string, unknown>, key: string): FieldRead<Record<string, unknown>> {
  const value = record[key]
  return isRecord(value) ? { ok: true, value } : fieldMissing
}

/** Read a required JSON array. */
function fieldArray(record: Record<string, unknown>, key: string): FieldRead<unknown[]> {
  const value = record[key]
  return Array.isArray(value) ? { ok: true, value } : fieldMissing
}

/** Code-unit string order; locale-independent so output stays deterministic. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Whether a value is a valid `DeviceStatusV2.lastResult`. */
function isStatusResult(value: unknown): value is DeviceStatusV2['lastResult'] {
  return (
    value === 'ok' ||
    value === 'no-changes' ||
    value === 'conflict' ||
    value === 'error' ||
    value === 'blocked' ||
    value === 'pending'
  )
}

/** Whether a value is a valid policy sync mode. */
function isSyncMode(value: unknown): value is RepoPolicyV2['sync']['mode'] {
  return value === 'two-way' || value === 'backup' || value === 'restore'
}

// ---------------------------------------------------------------------------
// Parsers (never throw, return null for implausible documents)
// ---------------------------------------------------------------------------

/** Parse a plugin scope; a missing scope falls back to the `all` default. */
function readScope(value: unknown): PluginScopeV2 | null {
  if (value === undefined) return { mode: 'all' }
  if (!isRecord(value)) return null
  const mode = value['mode']
  if (mode === 'all') return { mode: 'all' }
  if (mode !== 'devices') return null
  const devices = value['devices']
  if (devices === undefined) return { mode: 'devices', devices: [] }
  if (!Array.isArray(devices) || !devices.every(device => typeof device === 'string')) return null
  return { mode: 'devices', devices: [...devices] }
}

/** Parse a version policy; a missing value falls back to `track`. */
function readVersionPolicy(value: unknown): PluginVersionPolicyV2 | null {
  if (value === undefined) return 'track'
  return value === 'track' || value === 'pin' ? value : null
}

/** Parse one device plugin entry. */
function readPluginEntry(value: unknown): DevicePluginEntryV2 | null {
  if (!isRecord(value)) return null
  const id = fieldString(value, 'id')
  const version = fieldNullableString(value, 'version')
  const enabled = fieldBoolean(value, 'enabled')
  const installSpec = fieldNullableString(value, 'installSpec')
  const origin = fieldString(value, 'origin')
  const syncable = fieldBoolean(value, 'syncable')
  const pinnedVersion = fieldNullableString(value, 'pinnedVersion')
  const updatedAt = fieldString(value, 'updatedAt')
  const updatedBy = fieldString(value, 'updatedBy')
  const enabledOverride = fieldOptionalBoolean(value, 'enabledOverride')
  const scope = readScope(value['scope'])
  const versionPolicy = readVersionPolicy(value['versionPolicy'])
  if (
    !id.ok ||
    !version.ok ||
    !enabled.ok ||
    !enabledOverride.ok ||
    !installSpec.ok ||
    !origin.ok ||
    !syncable.ok ||
    !pinnedVersion.ok ||
    !updatedAt.ok ||
    !updatedBy.ok ||
    scope === null ||
    versionPolicy === null
  ) {
    return null
  }
  return {
    id: id.value,
    version: version.value,
    enabled: enabled.value,
    ...(enabledOverride.value === undefined ? {} : { enabledOverride: enabledOverride.value }),
    installSpec: installSpec.value,
    origin: origin.value,
    syncable: syncable.value,
    scope,
    versionPolicy,
    pinnedVersion: pinnedVersion.value,
    updatedAt: updatedAt.value,
    updatedBy: updatedBy.value,
  }
}

/** Parse one deletion intent. */
function readRemoval(value: unknown): DeviceRemovalV2 | null {
  if (!isRecord(value)) return null
  const id = fieldString(value, 'id')
  const at = fieldString(value, 'at')
  if (!id.ok || !at.ok) return null
  const name = value['name']
  if (name === undefined) return { id: id.value, at: at.value }
  return typeof name === 'string' ? { id: id.value, at: at.value, name } : null
}

/** Parse one skill record. */
function readSkill(value: unknown): DeviceSkillEntryV2 | null {
  if (!isRecord(value)) return null
  const name = fieldString(value, 'name')
  const hash = fieldString(value, 'hash')
  const files = fieldNumber(value, 'files')
  const updatedAt = fieldString(value, 'updatedAt')
  if (!name.ok || !hash.ok || !files.ok || !updatedAt.ok) return null
  const entry: DeviceSkillEntryV2 = {
    name: name.value,
    hash: hash.value,
    files: files.value,
    updatedAt: updatedAt.value,
  }
  const deleted = value['deleted']
  if (deleted !== undefined) {
    if (typeof deleted !== 'boolean') return null
    entry.deleted = deleted
  }
  return entry
}

/** Parse one pending-activation record. */
function readPendingActivation(value: unknown): DevicePendingActivationV2 | null {
  if (!isRecord(value)) return null
  const pluginId = fieldString(value, 'pluginId')
  const version = fieldString(value, 'version')
  const reason = fieldString(value, 'reason')
  if (!pluginId.ok || !version.ok || !reason.ok) return null
  return { pluginId: pluginId.value, version: version.value, reason: reason.value }
}

/** Parse a device status block. */
function readStatus(value: unknown): DeviceStatusV2 | null {
  if (!isRecord(value)) return null
  const lastSyncAt = fieldNullableString(value, 'lastSyncAt')
  const lastError = fieldNullableString(value, 'lastError')
  const lastResult = value['lastResult']
  if (!lastSyncAt.ok || !lastError.ok || !isStatusResult(lastResult)) return null
  const pending = value['pendingActivation']
  const pendingActivation: DevicePendingActivationV2[] = []
  if (pending !== undefined) {
    if (!Array.isArray(pending)) return null
    for (const item of pending) {
      const parsed = readPendingActivation(item)
      if (parsed === null) return null
      pendingActivation.push(parsed)
    }
  }
  return { lastSyncAt: lastSyncAt.value, lastResult, lastError: lastError.value, pendingActivation }
}

/** Parse the inline device identity block of a device manifest. */
function readDeviceInfo(value: unknown): DeviceManifestV2['device'] | null {
  if (!isRecord(value)) return null
  const id = fieldString(value, 'id')
  const name = fieldString(value, 'name')
  const platform = fieldString(value, 'platform')
  const arch = fieldString(value, 'arch')
  const dshVersion = fieldString(value, 'dshVersion')
  const pluginVersion = fieldString(value, 'pluginVersion')
  if (!id.ok || !name.ok || !platform.ok || !arch.ok || !dshVersion.ok || !pluginVersion.ok) return null
  return {
    id: id.value,
    name: name.value,
    platform: platform.value,
    arch: arch.value,
    dshVersion: dshVersion.value,
    pluginVersion: pluginVersion.value,
  }
}

/** Parse the root manifest. */
function readManifest(value: unknown): RepoManifestV2 | null {
  if (!isRecord(value)) return null
  if (value['schemaVersion'] !== REPO_SCHEMA_VERSION) return null
  const generator = fieldRecord(value, 'generator')
  const updatedAt = fieldString(value, 'updatedAt')
  if (!generator.ok || !updatedAt.ok) return null
  const generatorName = fieldString(generator.value, 'name')
  const generatorVersion = fieldString(generator.value, 'version')
  if (!generatorName.ok || !generatorVersion.ok) return null

  const profilesRaw = fieldRecord(value, 'profiles')
  if (!profilesRaw.ok) return null
  const profiles: Record<string, { pluginCount: number }> = {}
  for (const profile of Object.keys(profilesRaw.value).sort(compareStrings)) {
    const stats = profilesRaw.value[profile]
    if (!isRecord(stats)) return null
    const pluginCount = fieldNumber(stats, 'pluginCount')
    if (!pluginCount.ok) return null
    profiles[profile] = { pluginCount: pluginCount.value }
  }

  const devicesRaw = fieldArray(value, 'devices')
  if (!devicesRaw.ok) return null
  const devices: RepoDeviceRecordV2[] = []
  for (const item of devicesRaw.value) {
    const device = readRepoDevice(item)
    if (device === null) return null
    devices.push(device)
  }

  const manifest: RepoManifestV2 = {
    schemaVersion: REPO_SCHEMA_VERSION,
    generator: { name: generatorName.value, version: generatorVersion.value },
    profiles,
    devices,
    updatedAt: updatedAt.value,
  }
  // `migratedFrom` is optional metadata; ignore a malformed value instead of
  // rejecting the whole document.
  const migratedFrom = value['migratedFrom']
  if (typeof migratedFrom === 'number' && Number.isFinite(migratedFrom)) manifest.migratedFrom = migratedFrom
  return manifest
}

/** Parse one device row of the root manifest. */
function readRepoDevice(value: unknown): RepoDeviceRecordV2 | null {
  if (!isRecord(value)) return null
  const id = fieldString(value, 'id')
  const name = fieldString(value, 'name')
  const platform = fieldString(value, 'platform')
  const arch = fieldString(value, 'arch')
  const dshVersion = fieldString(value, 'dshVersion')
  const pluginVersion = fieldString(value, 'pluginVersion')
  const lastSyncAt = fieldNullableString(value, 'lastSyncAt')
  const lastCommit = fieldNullableString(value, 'lastCommit')
  const updatedAt = fieldString(value, 'updatedAt')
  if (
    !id.ok ||
    !name.ok ||
    !platform.ok ||
    !arch.ok ||
    !dshVersion.ok ||
    !pluginVersion.ok ||
    !lastSyncAt.ok ||
    !lastCommit.ok ||
    !updatedAt.ok
  ) {
    return null
  }
  const device: RepoDeviceRecordV2 = {
    id: id.value,
    name: name.value,
    platform: platform.value,
    arch: arch.value,
    dshVersion: dshVersion.value,
    pluginVersion: pluginVersion.value,
    lastSyncAt: lastSyncAt.value,
    lastCommit: lastCommit.value,
    updatedAt: updatedAt.value,
  }
  const lastResult = value['lastResult']
  if (typeof lastResult === 'string') device.lastResult = lastResult
  return device
}

/** Parse a policy document for `profile`. */
function readPolicy(value: unknown, profile: string): RepoPolicyV2 | null {
  if (!isRecord(value)) return null
  if (value['schemaVersion'] !== REPO_SCHEMA_VERSION) return null
  if (value['profile'] !== profile) return null

  const sync = fieldRecord(value, 'sync')
  const deletion = fieldRecord(value, 'deletion')
  const versions = fieldRecord(value, 'versions')
  const scope = fieldRecord(value, 'scope')
  const backupButton = fieldRecord(value, 'backupButton')
  const minDshVersion = fieldString(value, 'minDshVersion')
  if (
    !sync.ok ||
    !deletion.ok ||
    !versions.ok ||
    !scope.ok ||
    !backupButton.ok ||
    !minDshVersion.ok
  ) {
    return null
  }

  const mode = sync.value['mode']
  if (!isSyncMode(mode)) return null
  const auto = fieldRecord(sync.value, 'auto')
  if (!auto.ok) return null
  const autoEnabled = fieldBoolean(auto.value, 'enabled')
  const autoApply = auto.value['apply']
  const onStartup = fieldBoolean(auto.value, 'onStartup')
  const onPluginChange = fieldBoolean(auto.value, 'onPluginChange')
  if (!autoEnabled.ok || (autoApply !== 'safe' && autoApply !== 'all') || !onStartup.ok || !onPluginChange.ok) {
    return null
  }

  const propagate = fieldBoolean(deletion.value, 'propagate')
  if (!propagate.ok) return null

  const defaultMode = versions.value['default']
  const downgrade = versions.value['downgrade']
  const allowPrerelease = fieldBoolean(versions.value, 'allowPrerelease')
  if (defaultMode !== 'track' || (downgrade !== 'confirm' && downgrade !== 'allow' && downgrade !== 'block')) return null
  if (!allowPrerelease.ok) return null

  const defaultScope = scope.value['default']
  if (defaultScope !== 'all') return null
  const warnWhenMultiDevice = fieldBoolean(backupButton.value, 'warnWhenMultiDevice')
  if (!warnWhenMultiDevice.ok) return null

  return {
    schemaVersion: REPO_SCHEMA_VERSION,
    profile,
    sync: {
      mode,
      auto: {
        enabled: autoEnabled.value,
        apply: autoApply,
        onStartup: onStartup.value,
        onPluginChange: onPluginChange.value,
      },
    },
    deletion: { propagate: propagate.value },
    versions: { default: 'track', downgrade, allowPrerelease: allowPrerelease.value },
    scope: { default: 'all' },
    minDshVersion: minDshVersion.value,
    backupButton: { warnWhenMultiDevice: warnWhenMultiDevice.value },
  }
}

/** Parse a device manifest. */
function readDeviceManifest(value: unknown): DeviceManifestV2 | null {
  if (!isRecord(value)) return null
  if (value['schemaVersion'] !== REPO_SCHEMA_VERSION) return null
  const device = readDeviceInfo(value['device'])
  const profile = fieldString(value, 'profile')
  const updatedAt = fieldString(value, 'updatedAt')
  const baseCommit = fieldNullableString(value, 'baseCommit')
  if (device === null || !profile.ok || !updatedAt.ok || !baseCommit.ok) return null

  const pluginsRaw = fieldRecord(value, 'plugins')
  if (!pluginsRaw.ok) return null
  const plugins: Record<string, DevicePluginEntryV2> = {}
  for (const pluginId of Object.keys(pluginsRaw.value).sort(compareStrings)) {
    const entry = readPluginEntry(pluginsRaw.value[pluginId])
    if (entry === null) return null
    plugins[pluginId] = entry
  }

  const removed: DeviceRemovalV2[] = []
  const removedRaw = value['removed']
  if (removedRaw !== undefined) {
    if (!Array.isArray(removedRaw)) return null
    for (const item of removedRaw) {
      const removal = readRemoval(item)
      if (removal === null) return null
      removed.push(removal)
    }
  }

  const skills: Record<string, DeviceSkillEntryV2> = {}
  const skillsRaw = value['skills']
  if (skillsRaw !== undefined) {
    if (!isRecord(skillsRaw)) return null
    for (const skillName of Object.keys(skillsRaw).sort(compareStrings)) {
      const skill = readSkill(skillsRaw[skillName])
      if (skill === null) return null
      skills[skillName] = skill
    }
  }

  const status = readStatus(value['status'])
  if (status === null) return null

  return {
    schemaVersion: REPO_SCHEMA_VERSION,
    device,
    profile: profile.value,
    updatedAt: updatedAt.value,
    baseCommit: baseCommit.value,
    plugins,
    removed,
    skills,
    status,
  }
}

/** Validate a root manifest; returns null for anything that is not plausible v2. */
export function parseManifestV2(value: unknown): RepoManifestV2 | null {
  try {
    return readManifest(value)
  } catch {
    // getters on exotic inputs must not escape; untrusted input never throws.
    return null
  }
}

/** Validate a policy document; returns null for anything that is not plausible v2. */
export function parsePolicyV2(value: unknown, profile: string): RepoPolicyV2 | null {
  try {
    return readPolicy(value, profile)
  } catch {
    return null
  }
}

/** Validate a device manifest; returns null for anything that is not plausible v2. */
export function parseDeviceManifestV2(value: unknown): DeviceManifestV2 | null {
  try {
    return readDeviceManifest(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** Recursively sort object keys; arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortKeysDeep(item))
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort(compareStrings)) {
      const item = value[key]
      if (item !== undefined) sorted[key] = sortKeysDeep(item)
    }
    return sorted
  }
  return value
}

/** Canonical pretty JSON document: sorted keys, 2-space indent, trailing newline. */
function stringifyDocument(value: unknown): string {
  const text = JSON.stringify(sortKeysDeep(value), null, 2)
  return text === undefined ? '' : `${text}\n`
}

/** Serialize the root manifest. */
export function serializeManifestV2(value: RepoManifestV2): string {
  return stringifyDocument(value)
}

/** Serialize a policy document. */
export function serializePolicyV2(value: RepoPolicyV2): string {
  return stringifyDocument(value)
}

/** Serialize a device manifest. */
export function serializeDeviceManifestV2(value: DeviceManifestV2): string {
  return stringifyDocument(value)
}

// ---------------------------------------------------------------------------
// Desired-state merge
// ---------------------------------------------------------------------------

/** One plugin declaration paired with the device that wrote it. */
interface ScopedEntry {
  deviceId: string
  entry: DevicePluginEntryV2
}

/** Plugin to be installed after merging every applicable device declaration. */
export interface DesiredPluginV2 {
  id: string
  version: string | null
  enabled: boolean
  installSpec: string | null
  origin: string
  syncable: boolean
  pinned: boolean
  versionPolicy: PluginVersionPolicyV2
  sources: string[]
  updatedAt: string
  updatedBy: string
}

/** A declaration that cannot be resolved without a user decision. */
export interface DesiredConflictV2 {
  pluginId: string
  reason: 'pin-mismatch' | 'deleted-while-declared' | 'no-version'
  detail: string
  versions: string[]
}

/** A plugin skipped because this device cannot run it. */
export interface DesiredBlockedV2 {
  pluginId: string
  reason: 'min-dsh-version'
}

/** Result of the desired-state merge. */
export interface DesiredMergeV2 {
  plugins: Record<string, DesiredPluginV2>
  removals: string[]
  conflicts: DesiredConflictV2[]
  blocked: DesiredBlockedV2[]
  warnings: string[]
}

/** Strip one leading `v` from a version string (`v0.2.2` == `0.2.2`). */
function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/, '')
}

/**
 * Whether the local DSH version satisfies the repository minimum.
 *
 * A prerelease of the minimum's own core version counts as satisfying it, so
 * a `0.2.2` minimum accepts `0.2.2-rc.5` (the DSH release cycle ships
 * prereleases under the final version number). Unparsable versions are not
 * blocked: there is no reliable ordering to compare them with.
 */
function meetsMinimumDshVersion(local: string, minimum: string): boolean {
  const relation = compareVersions(local, minimum)
  if (relation === null) return true
  if (relation >= 0) return true
  const left = parseVersion(local)
  const right = parseVersion(minimum)
  if (left === null || right === null) return true
  const sameCore = left.major === right.major && left.minor === right.minor && left.patch === right.patch
  return sameCore && left.prerelease.length > 0 && right.prerelease.length === 0
}

/** Whether a scope applies to `selfId`. */
function scopeApplies(scope: PluginScopeV2, selfId: string): boolean {
  if (scope.mode === 'all') return true
  return (scope.devices ?? []).includes(selfId)
}

/** De-duplicate and sort device ids. */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

/** Reference version used to probe whether `compareVersions` understands a value. */
const VERSION_PROBE = '0.0.0'

/** Whether `compareVersions` can order this version string. */
function isOrderableVersion(version: string): boolean {
  return compareVersions(version, VERSION_PROBE) !== null
}

/** Ascending diagnostics order: semver first, unparsable versions last. */
function compareVersionStrings(a: string, b: string): number {
  const relation = compareVersions(a, b)
  if (relation !== null) return relation
  const aOrderable = isOrderableVersion(a)
  const bOrderable = isOrderableVersion(b)
  if (aOrderable !== bOrderable) return aOrderable ? -1 : 1
  return compareStrings(a, b)
}

/** Unique versions sorted for diagnostics. */
function sortVersions(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareVersionStrings)
}

/**
 * Pick the highest declared track version.
 *
 * Parsable versions always outrank unparsable ones. Unparsable versions compare
 * as equal to each other, so the last written declaration chooses the value
 * (with a lexical fallback) instead of an arbitrary ordering of garbage.
 */
function pickTrackVersion(trackEntries: readonly ScopedEntry[], candidates: readonly string[]): string | null {
  const orderable = candidates.filter(isOrderableVersion)
  if (orderable.length > 0) {
    let best: string | null = null
    for (const candidate of orderable) {
      if (best === null || compareVersions(candidate, best) === 1) best = candidate
    }
    return best
  }
  const written = trackEntries.filter(item => item.entry.version !== null)
  const lastWriter = pickLastWriter(written)
  const lastVersion = lastWriter === null ? null : lastWriter.entry.version
  if (lastVersion !== null) return lastVersion
  const sorted = [...candidates].sort(compareStrings)
  return sorted[sorted.length - 1] ?? null
}

/** A prerelease is any version containing `-` (`-rc` / `-beta` ...). */
function isPrereleaseVersion(version: string): boolean {
  return version.includes('-')
}

/** Rules 6/7: later `updatedAt` wins; ties go to the device id that sorts last. */
function compareWriters(a: ScopedEntry, b: ScopedEntry): number {
  const byTime = compareStrings(a.entry.updatedAt, b.entry.updatedAt)
  if (byTime !== 0) return byTime
  return compareStrings(a.deviceId, b.deviceId)
}

/** Last writer among `entries`, or null when empty. */
function pickLastWriter(entries: readonly ScopedEntry[]): ScopedEntry | null {
  let best: ScopedEntry | null = null
  for (const candidate of entries) {
    if (best === null || compareWriters(candidate, best) > 0) best = candidate
  }
  return best
}

/** Device ids that declared `version` (rule 8). */
function declarersOf(entries: readonly ScopedEntry[], version: string): string[] {
  const deviceIds: string[] = []
  for (const { deviceId, entry } of entries) {
    const declared = entry.versionPolicy === 'pin' ? entry.pinnedVersion : entry.version
    if (declared === version) deviceIds.push(deviceId)
  }
  return uniqueSorted(deviceIds)
}

/** Total order over manifests so merge output never depends on input order. */
function compareManifests(a: DeviceManifestV2, b: DeviceManifestV2): number {
  return (
    compareStrings(a.device.id, b.device.id) ||
    compareStrings(a.profile, b.profile) ||
    compareStrings(a.updatedAt, b.updatedAt) ||
    compareStrings(a.device.name, b.device.name)
  )
}

/** Build the merged declaration once a version and its supplier are known. */
function buildDesiredPlugin(
  pluginId: string,
  version: string,
  pinned: boolean,
  supplier: ScopedEntry,
  enabled: boolean,
  entries: readonly ScopedEntry[],
): DesiredPluginV2 {
  return {
    id: pluginId,
    version,
    enabled,
    installSpec: supplier.entry.installSpec,
    origin: supplier.entry.origin,
    syncable: supplier.entry.syncable,
    pinned,
    versionPolicy: pinned ? 'pin' : 'track',
    sources: declarersOf(entries, version),
    updatedAt: supplier.entry.updatedAt,
    updatedBy: supplier.entry.updatedBy,
  }
}

/**
 * Compute this device's desired plugin state from every device declaration.
 *
 * The rules implemented here are the ones from `docs/MULTI_DEVICE_SYNC.md`
 * §4.2 and §5.1: scope filtering, pin-over-track, highest compatible version,
 * last-writer-wins enabled state, deletion propagation, and conflicts that must
 * be decided before anything is installed or removed.
 */
export function mergeDesired(input: {
  selfId: string
  policy: RepoPolicyV2
  devices: DeviceManifestV2[]
  localDshVersion: string
}): DesiredMergeV2 {
  const warnings: string[] = []
  const seenWarnings = new Set<string>()
  const warn = (message: string): void => {
    if (seenWarnings.has(message)) return
    seenWarnings.add(message)
    warnings.push(message)
  }
  const conflicts: DesiredConflictV2[] = []
  const blocked: DesiredBlockedV2[] = []
  const removals = new Set<string>()
  const plugins: Record<string, DesiredPluginV2> = {}

  const manifests = [...input.devices].sort(compareManifests)

  // Rule 1: entries whose scope covers this device participate. Non-syncable
  // declarations are kept for rule 3 ("still declared") but never become
  // desired, and only syncable ones can be installed.
  const scopedEntries = new Map<string, ScopedEntry[]>()
  for (const manifest of manifests) {
    for (const pluginId of Object.keys(manifest.plugins).sort(compareStrings)) {
      const entry = manifest.plugins[pluginId]
      if (entry === undefined || !scopeApplies(entry.scope, input.selfId)) continue
      const list = scopedEntries.get(pluginId)
      const scoped: ScopedEntry = { deviceId: manifest.device.id, entry }
      if (list === undefined) scopedEntries.set(pluginId, [scoped])
      else list.push(scoped)
    }
  }

  // Rule 2: a device below the policy minimum does nothing at all.
  const localVersion = stripVersionPrefix(input.localDshVersion)
  const minimumVersion = input.policy.minDshVersion.trim()
  if (!meetsMinimumDshVersion(localVersion, minimumVersion)) {
    for (const pluginId of [...scopedEntries.keys()].sort(compareStrings)) {
      const entries = scopedEntries.get(pluginId) ?? []
      if (!entries.some(item => item.entry.syncable)) continue
      blocked.push({ pluginId, reason: 'min-dsh-version' })
    }
    warn(
      `Local DSH version ${input.localDshVersion} is below the repository minimum ` +
        `${input.policy.minDshVersion}; no plugin is synchronized.`,
    )
    return { plugins, removals: [], conflicts, blocked, warnings }
  }

  // Rule 3: explicit deletions from every device manifest.
  const removedBy = new Map<string, string[]>()
  for (const manifest of manifests) {
    for (const removal of manifest.removed) {
      const list = removedBy.get(removal.id)
      if (list === undefined) removedBy.set(removal.id, [manifest.device.id])
      else list.push(manifest.device.id)
    }
  }

  const conflictedRemovals = new Set<string>()
  for (const pluginId of [...removedBy.keys()].sort(compareStrings)) {
    const removerIds = uniqueSorted(removedBy.get(pluginId) ?? [])
    const declarers = uniqueSorted((scopedEntries.get(pluginId) ?? []).map(item => item.deviceId))
    if (declarers.length > 0) {
      // Deleted on one device while another still declares it: needs a decision
      // either way, so it is neither installed nor removed.
      conflictedRemovals.add(pluginId)
      if (input.policy.deletion.propagate) {
        conflicts.push({
          pluginId,
          reason: 'deleted-while-declared',
          detail:
            `Plugin ${pluginId} was removed by ${removerIds.join(', ')} but is still declared by ` +
            `${declarers.join(', ')}; it stays untouched until the deletion is confirmed.`,
          versions: [],
        })
      } else {
        warn(
          `Plugin ${pluginId} was removed by ${removerIds.join(', ')} but is still declared by ` +
            `${declarers.join(', ')}; deletion.propagate is false, so it is left untouched.`,
        )
      }
      continue
    }
    if (input.policy.deletion.propagate) {
      removals.add(pluginId)
    } else {
      warn(
        `Plugin ${pluginId} was removed by ${removerIds.join(', ')}; ` +
          'deletion.propagate is false, so the removal is not applied.',
      )
    }
  }

  // Rules 4-8: per plugin, pins first, then the highest tracked version.
  for (const pluginId of [...scopedEntries.keys()].sort(compareStrings)) {
    if (conflictedRemovals.has(pluginId)) continue
    const entries = (scopedEntries.get(pluginId) ?? []).filter(item => item.entry.syncable)
    if (entries.length === 0) continue
    const lastWriter = pickLastWriter(entries)
    if (lastWriter === null) continue
    // An explicit override on this device's own declaration wins for this
    // device only; without one, the last writer decides globally.
    const ownOverride = entries.find(item => item.deviceId === input.selfId)?.entry.enabledOverride
    const enabled = ownOverride ?? lastWriter.entry.enabled

    const pinEntries = entries.filter(item => item.entry.versionPolicy === 'pin')
    const pinnedVersions = sortVersions(
      pinEntries.flatMap(item => (item.entry.pinnedVersion === null ? [] : [item.entry.pinnedVersion])),
    )
    if (pinnedVersions.length > 1) {
      conflicts.push({
        pluginId,
        reason: 'pin-mismatch',
        detail: `Conflicting pin versions are declared for ${pluginId}: ${pinnedVersions.join(', ')}.`,
        versions: pinnedVersions,
      })
      continue
    }

    const [pinnedVersion] = pinnedVersions
    if (pinnedVersion !== undefined) {
      const supplier = pickLastWriter(pinEntries.filter(item => item.entry.pinnedVersion === pinnedVersion))
      if (supplier === null) continue
      plugins[pluginId] = buildDesiredPlugin(pluginId, pinnedVersion, true, supplier, enabled, entries)
      continue
    }

    const trackEntries = entries.filter(item => item.entry.versionPolicy !== 'pin')
    let candidates = sortVersions(
      trackEntries.flatMap(item => (item.entry.version === null ? [] : [item.entry.version])),
    )
    if (!input.policy.versions.allowPrerelease) {
      const stable = candidates.filter(version => !isPrereleaseVersion(version))
      if (stable.length > 0) {
        candidates = stable
      } else if (candidates.length > 0) {
        // Rule 5: only prereleases remain and the policy forbids them.
        conflicts.push({
          pluginId,
          reason: 'no-version',
          detail:
            `Only prerelease versions are declared for ${pluginId} (${candidates.join(', ')}); ` +
            'versions.allowPrerelease is false.',
          versions: candidates,
        })
        continue
      }
    }
    if (candidates.length === 0) {
      conflicts.push({
        pluginId,
        reason: 'no-version',
        detail: `No device declared a usable version for ${pluginId}.`,
        versions: candidates,
      })
      continue
    }
    const chosenVersion = pickTrackVersion(trackEntries, candidates)
    if (chosenVersion === null) continue
    const supplier = pickLastWriter(trackEntries.filter(item => item.entry.version === chosenVersion))
    if (supplier === null) continue
    plugins[pluginId] = buildDesiredPlugin(pluginId, chosenVersion, false, supplier, enabled, entries)
  }

  conflicts.sort((a, b) => compareStrings(a.pluginId, b.pluginId) || compareStrings(a.reason, b.reason))
  blocked.sort((a, b) => compareStrings(a.pluginId, b.pluginId))
  return {
    plugins,
    removals: [...removals].sort(compareStrings),
    conflicts,
    blocked,
    warnings,
  }
}
