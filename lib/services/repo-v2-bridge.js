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
import { createHash } from 'node:crypto';
import { defaultPolicy, deviceManifestPath, manifestPath, mergeDesired, parseDeviceManifestV2, parseManifestV2, parsePolicyV2, parsePoolRemovalsV2, POOL_REMOVALS_PATH, policyPath, serializeDeviceManifestV2, serializeManifestV2, serializePolicyV2, serializePoolRemovalsV2, } from './repo-v2.js';
/** Parse one JSON document without throwing. */
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
/** The repository schema version, or null when there is no readable manifest. */
export async function detectRepoSchemaVersion(store) {
    const text = await store.readRepoText(manifestPath);
    if (text === null)
        return null;
    const parsed = parseJson(text);
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const value = parsed.schemaVersion;
    return typeof value === 'number' ? value : null;
}
/** Stable fallback id for a device name that has no repository record yet. */
export function deviceIdForName(name) {
    return `dev-${createHash('sha256').update(`dsh-git-plugin-sync\u0000${name}`).digest('hex').slice(0, 16)}`;
}
/**
 * Resolve which repository device record belongs to this machine. The configured
 * device name is the identity: typing an existing name on a new machine adopts
 * that device's declaration (and therefore its private plugins); a name with no
 * record keeps the machine id; renaming a known machine to a brand-new name
 * starts a fresh record so private plugins are not silently carried over.
 */
export function resolveDeviceId(devices, self) {
    const matches = devices
        .filter(entry => entry.name === self.name)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (matches.length > 0)
        return matches[0].id;
    const byId = devices.find(entry => entry.id === self.id);
    if (byId !== undefined && byId.name !== self.name)
        return deviceIdForName(self.name);
    return self.id;
}
/** Read and merge the v2 repository. Returns null when it is not a v2 repository. */
export async function readV2State(store, profile, self) {
    const text = await store.readRepoText(manifestPath);
    if (text === null)
        return null;
    const manifest = parseManifestV2(parseJson(text));
    if (manifest === null)
        return null;
    const policyText = await store.readRepoText(policyPath(profile));
    const policy = policyText === null ? null : parsePolicyV2(parseJson(policyText), profile);
    const devices = [];
    const directories = await store.listRepoPath('devices');
    if (directories !== null) {
        const sorted = directories.filter(entry => entry.directory).sort((a, b) => a.name.localeCompare(b.name));
        for (const directory of sorted) {
            const raw = await store.readRepoText(deviceManifestPath(directory.name, profile));
            if (raw === null)
                continue;
            const device = parseDeviceManifestV2(parseJson(raw));
            if (device === null || device.device.id !== directory.name)
                continue;
            devices.push(device);
        }
    }
    const selfId = resolveDeviceId(devices.map(device => ({ id: device.device.id, name: device.device.name, updatedAt: device.updatedAt })), self);
    const effectivePolicy = policy ?? defaultPolicy(profile);
    const desired = mergeDesired({ selfId, policy: effectivePolicy, devices, localDshVersion: self.dshVersion });
    const byId = {};
    for (const device of devices)
        byId[device.device.id] = device;
    const poolText = await store.readRepoText(POOL_REMOVALS_PATH);
    const pool = poolText === null ? null : parsePoolRemovalsV2(parseJson(poolText));
    return {
        manifest,
        policy: effectivePolicy,
        devices,
        byId,
        desired,
        selfId,
        selfDevice: byId[selfId] ?? null,
        poolRemovals: pool?.removed ?? [],
    };
}
/** Project the merged desired state onto the v1 `RemoteProfileState` shape. */
export function desiredRemoteState(read, profile, now) {
    const plugins = {};
    for (const [id, plugin] of Object.entries(read.desired.plugins).sort(([a], [b]) => a.localeCompare(b))) {
        plugins[id] = {
            id,
            name: id,
            version: plugin.version,
            origin: plugin.origin,
            installSpec: plugin.installSpec,
            enabled: plugin.enabled,
            builtIn: false,
            syncable: plugin.syncable,
            pathOnly: false,
            rows: [],
            updatedAt: plugin.updatedAt,
            updatedBy: plugin.updatedBy,
        };
    }
    // Another device's scope restriction is not a repository-wide deletion: keep
    // it out of the v1 mirror's tombstone view, which has no per-device notion.
    const restricted = new Set(read.desired.scopeExcluded);
    const deletionIntents = new Set(read.desired.removals);
    for (const removal of read.poolRemovals)
        deletionIntents.add(removal.id);
    for (const conflict of read.desired.conflicts) {
        if (conflict.reason === 'deleted-while-declared')
            deletionIntents.add(conflict.pluginId);
    }
    for (const id of deletionIntents) {
        if (restricted.has(id))
            continue;
        plugins[id] = {
            id,
            name: id,
            version: null,
            origin: 'unknown',
            installSpec: null,
            enabled: false,
            builtIn: false,
            syncable: true,
            pathOnly: false,
            rows: [],
            deleted: true,
            updatedAt: now,
            updatedBy: '',
        };
    }
    return {
        schemaVersion: 2,
        profile,
        updatedAt: now,
        plugins,
    };
}
/** Convert merge conflicts into the planners' `ConflictInfo` shape. */
export function desiredConflicts(read, local) {
    return read.desired.conflicts.map(conflict => {
        const plugin = local[conflict.pluginId];
        const fields = conflict.reason === 'pin-mismatch' ? ['version'] : conflict.reason === 'deleted-while-declared' ? ['presence'] : ['version'];
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
        };
    });
}
/** Build this device's declaration for the repository. */
export function buildOwnDeviceManifest(input) {
    const identity = input.self;
    const device = identity === undefined ? input.inventory.device : { ...input.inventory.device, ...identity };
    const after = input.after ?? input.inventory;
    const previous = input.previous;
    const current = new Map();
    for (const plugin of after.plugins) {
        if (plugin.builtIn || !plugin.syncable)
            continue;
        current.set(plugin.id, plugin);
    }
    const plugins = {};
    for (const [id, plugin] of [...current.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const old = previous?.plugins[id];
        // A local enabled override makes the local enabled state personal: keep the
        // shared vote this declaration already carried instead of rewriting it from
        // the device-local state on every sync (which would flip other devices).
        const enabled = old?.enabledOverride === undefined ? plugin.enabled : (old.enabled ?? plugin.enabled);
        plugins[id] = {
            id,
            version: plugin.version,
            enabled,
            ...(old?.enabledOverride === undefined ? {} : { enabledOverride: old.enabledOverride }),
            installSpec: plugin.installSpec,
            origin: plugin.origin,
            syncable: plugin.syncable,
            scope: old?.scope ?? { mode: 'all' },
            versionPolicy: old?.versionPolicy ?? 'track',
            pinnedVersion: old?.pinnedVersion ?? null,
            updatedAt: input.now,
            updatedBy: device.id,
        };
    }
    const previousPlugins = previous?.plugins ?? {};
    const removed = [...(previous?.removed ?? [])];
    const knownRemoved = new Set(removed.map(entry => entry.id));
    const candidates = new Set(input.explicitRemovals ?? []);
    for (const id of Object.keys(previousPlugins))
        candidates.add(id);
    for (const id of [...candidates].sort()) {
        if (current.has(id))
            continue;
        if (input.protectedIds?.has(id) === true)
            continue;
        if (knownRemoved.has(id))
            continue;
        const name = previousPlugins[id]?.id ?? id;
        removed.push({ id, at: input.now, name });
        knownRemoved.add(id);
    }
    // A plugin that is declared again is no longer pending deletion, and an id
    // protected by the caller (external removal / restriction) is not this
    // device's deletion intent either.
    const pruned = removed.filter(entry => !current.has(entry.id) && input.protectedIds?.has(entry.id) !== true);
    const status = {
        lastSyncAt: input.now,
        lastResult: input.lastResult ?? 'ok',
        lastError: input.lastError ?? null,
        pendingActivation: [...(input.pendingActivation ?? [])],
    };
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
        skills: input.skills ?? previous?.skills ?? {},
        status,
    };
}
/** Device record derived from the current device. */
function deviceRecord(device, lastCommit) {
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
    };
}
/** Files to add to the next backup commit, keyed by repository-relative path. */
export function buildV2RepoFiles(input) {
    const { selfManifest, profile, now } = input;
    const selfId = selfManifest.device.id;
    const existingDevices = new Map();
    for (const record of input.read?.manifest.devices ?? [])
        existingDevices.set(record.id, record);
    for (const [id, legacy] of Object.entries(input.legacyDevices ?? {})) {
        if (existingDevices.has(id))
            continue;
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
        });
    }
    existingDevices.set(selfId, deviceRecord(selfManifest, input.commit ?? null));
    const devices = [...existingDevices.values()].sort((a, b) => a.id.localeCompare(b.id));
    const pluginCount = Object.keys(selfManifest.plugins).length;
    const migratedFrom = input.read === null && Object.keys(input.legacyDevices ?? {}).length > 0;
    const manifest = {
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
    };
    const policy = input.read?.policy ?? defaultPolicy(profile);
    const pool = new Map();
    for (const entry of input.read?.poolRemovals ?? [])
        pool.set(entry.id, entry);
    for (const id of input.poolRemovals?.clear ?? [])
        pool.delete(id);
    const by = selfManifest.device.id;
    for (const id of input.poolRemovals?.add ?? []) {
        pool.set(id, {
            id,
            ...(input.poolRemovals?.names?.[id] === undefined ? {} : { name: input.poolRemovals.names[id] }),
            at: now,
            by,
        });
    }
    const files = {
        [manifestPath]: serializeManifestV2(manifest),
        [policyPath(profile)]: serializePolicyV2(policy),
        [deviceManifestPath(selfId, profile)]: serializeDeviceManifestV2(selfManifest),
    };
    if (pool.size > 0) {
        const document = {
            schemaVersion: 2,
            updatedAt: now,
            removed: [...pool.values()].sort((left, right) => left.id.localeCompare(right.id)),
        };
        files[POOL_REMOVALS_PATH] = serializePoolRemovalsV2(document);
    }
    return files;
}
/** Read the pending activations recorded in this device's previous manifest. */
export function previousPendingActivation(previous) {
    return previous === null ? [] : [...previous.status.pendingActivation];
}
