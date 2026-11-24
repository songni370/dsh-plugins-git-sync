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
import { type DesiredMergeV2, type DeviceManifestV2, type DevicePendingActivationV2, type DeviceStatusV2, type RepoManifestV2, type RepoPolicyV2, type PoolRemovalV2 } from './repo-v2.js';
import type { ConflictInfo, DeviceInfo, DeviceInventory, PluginRecord, RemoteProfileState } from '../types.js';
/** The subset of `RepoStore` the v2 bridge needs. */
export interface RepoV2Store {
    readRepoText(relative: string): Promise<string | null>;
    listRepoPath(relative: string): Promise<Array<{
        name: string;
        directory: boolean;
    }> | null>;
}
/** Everything read from a v2 repository for one profile. */
export interface RepoV2Read {
    manifest: RepoManifestV2;
    policy: RepoPolicyV2;
    devices: DeviceManifestV2[];
    byId: Record<string, DeviceManifestV2>;
    desired: DesiredMergeV2;
    /** Device id used for this device, resolved from the configured device name. */
    selfId: string;
    /** This device's previous declaration, when it exists. */
    selfDevice: DeviceManifestV2 | null;
    /** Public-pool deletion intents shared by every device. */
    poolRemovals: PoolRemovalV2[];
}
/** The repository schema version, or null when there is no readable manifest. */
export declare function detectRepoSchemaVersion(store: RepoV2Store): Promise<number | null>;
/** Stable fallback id for a device name that has no repository record yet. */
export declare function deviceIdForName(name: string): string;
/**
 * Resolve which repository device record belongs to this machine. The configured
 * device name is the identity: typing an existing name on a new machine adopts
 * that device's declaration (and therefore its private plugins); a name with no
 * record keeps the machine id; renaming a known machine to a brand-new name
 * starts a fresh record so private plugins are not silently carried over.
 */
export declare function resolveDeviceId(devices: ReadonlyArray<{
    id: string;
    name: string;
    updatedAt: string;
}>, self: {
    id: string;
    name: string;
}): string;
/** Read and merge the v2 repository. Returns null when it is not a v2 repository. */
export declare function readV2State(store: RepoV2Store, profile: string, self: {
    id: string;
    name: string;
    dshVersion: string;
}): Promise<RepoV2Read | null>;
/** Project the merged desired state onto the v1 `RemoteProfileState` shape. */
export declare function desiredRemoteState(read: RepoV2Read, profile: string, now: string): RemoteProfileState;
/** Convert merge conflicts into the planners' `ConflictInfo` shape. */
export declare function desiredConflicts(read: RepoV2Read, local: Readonly<Record<string, PluginRecord>>): ConflictInfo[];
/** Input for building this device's own v2 manifest after a successful run. */
export interface OwnDeviceManifestInput {
    previous: DeviceManifestV2 | null;
    inventory: DeviceInventory;
    /** Fresh successful scan after local actions; defaults to `inventory`. */
    after?: DeviceInventory;
    profile: string;
    now: string;
    /** Plugins explicitly removed by this run (repository deletions propagated here). */
    explicitRemovals?: ReadonlySet<string>;
    /** Plugins whose install failed; never record these as deliberate removals. */
    protectedIds?: ReadonlySet<string>;
    pendingActivation?: readonly DevicePendingActivationV2[];
    lastResult?: DeviceStatusV2['lastResult'];
    lastError?: string | null;
    baseCommit?: string | null;
    /** Skill declarations to write; defaults to the previous manifest's entries. */
    skills?: Record<string, import('./repo-v2.js').DeviceSkillEntryV2>;
    /** Repository identity for this run (configured device name may adopt an existing record). */
    self?: {
        id: string;
        name: string;
    };
}
/** Build this device's declaration for the repository. */
export declare function buildOwnDeviceManifest(input: OwnDeviceManifestInput): DeviceManifestV2;
/** One legacy device snapshot, used when migrating a v1 repository. */
export interface LegacyDeviceRecord {
    device: DeviceInfo;
    updatedAt: string;
}
/** Public-pool deletion intents to add or clear in this commit. */
export interface PoolRemovalUpdate {
    add?: ReadonlySet<string>;
    clear?: ReadonlySet<string>;
    names?: Readonly<Record<string, string>>;
}
/** Input for building the v2 files of one commit. */
export interface BuildV2FilesInput {
    /** Existing v2 state; null when creating or migrating the repository. */
    read: RepoV2Read | null;
    selfManifest: DeviceManifestV2;
    profile: string;
    pluginVersion: string;
    now: string;
    legacyDevices?: Readonly<Record<string, LegacyDeviceRecord>>;
    commit?: string | null;
    /** Public-pool deletion intents changed by this run. */
    poolRemovals?: PoolRemovalUpdate;
}
/** Files to add to the next backup commit, keyed by repository-relative path. */
export declare function buildV2RepoFiles(input: BuildV2FilesInput): Record<string, string>;
/** Read the pending activations recorded in this device's previous manifest. */
export declare function previousPendingActivation(previous: DeviceManifestV2 | null): DevicePendingActivationV2[];
