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
/** Format version written into every v2 document. */
export declare const REPO_SCHEMA_VERSION = 2;
/** Which devices a plugin declaration applies to. */
export interface PluginScopeV2 {
    mode: 'all' | 'devices';
    devices?: string[];
}
/** How a device follows versions for one plugin. */
export type PluginVersionPolicyV2 = 'track' | 'pin';
/** One plugin declaration inside a device manifest. */
export interface DevicePluginEntryV2 {
    id: string;
    version: string | null;
    enabled: boolean;
    /**
     * Explicit per-device override for the desired enabled state. When this
     * device declares it, it wins over the last-writer-wins result for this
     * device only; other devices keep merging normally.
     */
    enabledOverride?: boolean;
    installSpec: string | null;
    origin: string;
    syncable: boolean;
    scope: PluginScopeV2;
    versionPolicy: PluginVersionPolicyV2;
    pinnedVersion: string | null;
    updatedAt: string;
    updatedBy: string;
}
/** One explicit deletion intent recorded by a device. */
export interface DeviceRemovalV2 {
    id: string;
    at: string;
    name?: string;
}
/** One skill directory recorded by a device manifest. */
export interface DeviceSkillEntryV2 {
    name: string;
    hash: string;
    files: number;
    updatedAt: string;
    deleted?: boolean;
}
/** One plugin that is installed but not active until DSH restarts. */
export interface DevicePendingActivationV2 {
    pluginId: string;
    version: string;
    reason: string;
}
/** Per-device synchronization status, visible to every other device. */
export interface DeviceStatusV2 {
    lastSyncAt: string | null;
    lastResult: 'ok' | 'no-changes' | 'conflict' | 'error' | 'blocked' | 'pending';
    lastError: string | null;
    pendingActivation: DevicePendingActivationV2[];
}
/** `devices/<deviceId>/<profile>.json`: one device's declared expected state. */
export interface DeviceManifestV2 {
    schemaVersion: 2;
    device: {
        id: string;
        name: string;
        platform: string;
        arch: string;
        dshVersion: string;
        pluginVersion: string;
    };
    profile: string;
    updatedAt: string;
    baseCommit: string | null;
    plugins: Record<string, DevicePluginEntryV2>;
    removed: DeviceRemovalV2[];
    skills: Record<string, DeviceSkillEntryV2>;
    status: DeviceStatusV2;
}
/** One device row in the root manifest. */
export interface RepoDeviceRecordV2 {
    id: string;
    name: string;
    platform: string;
    arch: string;
    dshVersion: string;
    pluginVersion: string;
    lastSyncAt: string | null;
    lastCommit: string | null;
    updatedAt: string;
    lastResult?: string;
}
/** `manifest.json`: the repository index. */
export interface RepoManifestV2 {
    schemaVersion: 2;
    generator: {
        name: string;
        version: string;
    };
    migratedFrom?: number;
    profiles: Record<string, {
        pluginCount: number;
    }>;
    devices: RepoDeviceRecordV2[];
    updatedAt: string;
}
/** `policies/<profile>.json`: the shared default policy for one profile. */
export interface RepoPolicyV2 {
    schemaVersion: 2;
    profile: string;
    sync: {
        mode: 'two-way' | 'backup' | 'restore';
        auto: {
            enabled: boolean;
            apply: 'safe' | 'all';
            onStartup: boolean;
            onPluginChange: boolean;
        };
    };
    deletion: {
        propagate: boolean;
    };
    versions: {
        default: 'track';
        downgrade: 'confirm' | 'allow' | 'block';
        allowPrerelease: boolean;
    };
    scope: {
        default: 'all';
    };
    minDshVersion: string;
    backupButton: {
        warnWhenMultiDevice: boolean;
    };
}
/** The policy a fresh v2 repository starts with. */
export declare const defaultPolicy: (profile: string) => RepoPolicyV2;
/** Path of the root manifest. */
export declare const manifestPath = "manifest.json";
/** Path of one profile's policy document. */
export declare const policyPath: (profile: string) => string;
/** Path of one device's manifest for one profile. */
export declare const deviceManifestPath: (deviceId: string, profile: string) => string;
/** Validate a root manifest; returns null for anything that is not plausible v2. */
export declare function parseManifestV2(value: unknown): RepoManifestV2 | null;
/** Validate a policy document; returns null for anything that is not plausible v2. */
export declare function parsePolicyV2(value: unknown, profile: string): RepoPolicyV2 | null;
/** Validate a device manifest; returns null for anything that is not plausible v2. */
export declare function parseDeviceManifestV2(value: unknown): DeviceManifestV2 | null;
/** Serialize the root manifest. */
export declare function serializeManifestV2(value: RepoManifestV2): string;
/** Serialize a policy document. */
export declare function serializePolicyV2(value: RepoPolicyV2): string;
/** Serialize a device manifest. */
export declare function serializeDeviceManifestV2(value: DeviceManifestV2): string;
/** Plugin to be installed after merging every applicable device declaration. */
export interface DesiredPluginV2 {
    id: string;
    version: string | null;
    enabled: boolean;
    installSpec: string | null;
    origin: string;
    syncable: boolean;
    pinned: boolean;
    versionPolicy: PluginVersionPolicyV2;
    sources: string[];
    updatedAt: string;
    updatedBy: string;
}
/** A declaration that cannot be resolved without a user decision. */
export interface DesiredConflictV2 {
    pluginId: string;
    reason: 'pin-mismatch' | 'deleted-while-declared' | 'no-version';
    detail: string;
    versions: string[];
}
/** A plugin skipped because this device cannot run it. */
export interface DesiredBlockedV2 {
    pluginId: string;
    reason: 'min-dsh-version';
}
/** Result of the desired-state merge. */
export interface DesiredMergeV2 {
    plugins: Record<string, DesiredPluginV2>;
    removals: string[];
    /** Removals caused only by another device's explicit scope restriction. */
    scopeExcluded: string[];
    conflicts: DesiredConflictV2[];
    blocked: DesiredBlockedV2[];
    warnings: string[];
}
/**
 * Compute this device's desired plugin state from every device declaration.
 *
 * The rules implemented here are the ones from `docs/MULTI_DEVICE_SYNC.md`
 * §4.2 and §5.1: scope filtering, pin-over-track, highest compatible version,
 * last-writer-wins enabled state, deletion propagation, and conflicts that must
 * be decided before anything is installed or removed.
 */
export declare function mergeDesired(input: {
    selfId: string;
    policy: RepoPolicyV2;
    devices: DeviceManifestV2[];
    localDshVersion: string;
}): DesiredMergeV2;
