/**
 * The single orchestration surface used by both the settings page and the agent
 * tools.
 *
 * One operation is implemented once here; the HTTP routes and the tools are
 * thin adapters that call these methods with the same meaning. The engine owns
 * the mutex (one synchronization at a time), the safety snapshot, the baseline
 * update and the persisted status.
 * @module services/engine
 */
import { PACKAGE_NAME } from '../constants.js';
import { SyncError, errorMessage, toSyncError } from '../core/errors.js';
import { displayPath } from '../core/paths.js';
import { Mutex } from '../core/mutex.js';
import { safeJsonCopy } from './engine-utils.js';
import { baselinePluginState, isSyncable, localPluginState, remotePluginState, } from './model.js';
import { countPlanChanges, planBackup, planRestore, planSync } from './plan.js';
import { buildBackupFiles, buildBaseline, joinRepoPath, toDeviceSnapshot, toRemoteEntry, } from './repo-files.js';
import { buildOwnDeviceManifest, buildV2RepoFiles, detectRepoSchemaVersion, desiredRemoteState, previousPendingActivation, readV2State, } from './repo-v2-bridge.js';
import { executeLocalActions, isLocalAction } from './executor.js';
import { createSnapshotService, snapshotConfigs } from './snapshot.js';
import { fileExists } from '../state/store.js';
import { mergeSkills, restoreMissingSkills, scanSkills, skillBytes, skillSyncStatus } from '../skills/skills.js';
import { join } from 'node:path';
const EMPTY_REMOTE = { manifest: null, state: null, configs: {}, skills: null, devices: {}, head: null, v2: null };
/**
 * Whether a plugin belongs in the user-facing inventory.
 *
 * DSH built-in/official plugins, the DSH loader's internal `cordis:*` rows and
 * this plugin itself are deliberately excluded from backup and from the
 * selectable list — counts must use the same predicate or the status card and
 * the plugin list disagree (e.g. "local 8" vs a six-row list).
 */
function isListedPlugin(name, builtIn) {
    if (builtIn)
        return false;
    if (name === PACKAGE_NAME)
        return false;
    if (name.startsWith('cordis:'))
        return false;
    return true;
}
/** Convert a repository state map into comparable plugin states. */
function remoteStates(read) {
    const out = {};
    for (const [id, entry] of Object.entries(read.state?.plugins ?? {})) {
        const state = remotePluginState(entry);
        if (state === null)
            continue;
        state.configs = read.configs[id] ?? {};
        out[id] = state;
    }
    return out;
}
/** Convert local inventory into comparable plugin states. */
function localStates(inventory) {
    const out = {};
    for (const record of inventory.plugins)
        out[record.id] = localPluginState(record);
    return out;
}
/** Convert a baseline into comparable plugin states. */
function baselineStates(baseline) {
    const out = {};
    for (const [id, entry] of Object.entries(baseline?.plugins ?? {})) {
        out[id] = baselinePluginState(id, entry, id);
    }
    return out;
}
/** Build remote metadata for conflict explanations. */
function remoteMeta(read) {
    const out = {};
    for (const [id, entry] of Object.entries(read.state?.plugins ?? {})) {
        out[id] = {
            updatedBy: entry.updatedBy,
            updatedAt: entry.updatedAt,
            platform: read.devices[entry.updatedBy]?.device.platform,
        };
    }
    return out;
}
/**
 * Conflicts still needing a decision.
 *
 * The planner itself removes every conflict a supplied resolution actually
 * resolved, so `plan.conflicts` is already the exact unresolved set: filtering
 * by the caller's resolution list a second time would treat a resolution the
 * planner could not apply as handled, and the operation would silently skip
 * it.
 */
function unresolvedConflicts(plan) {
    return plan.conflicts;
}
/**
 * Conflicts that still block an operation.
 *
 * An explicit `skip` resolution is a real decision: leave this plugin exactly
 * as it is and let the rest of the plan run. The conflict stays in
 * `plan.conflicts` (so it is still visible), but it must not turn into a
 * `conflict-present` error after the user chose to skip it.
 */
function blockingConflicts(plan, resolutions) {
    if (resolutions === undefined || resolutions.length === 0)
        return unresolvedConflicts(plan);
    const skipped = new Set(resolutions.filter(item => item.choice === 'skip').map(item => item.pluginId));
    return unresolvedConflicts(plan).filter(conflict => !skipped.has(conflict.pluginId));
}
/** Human-readable conflict summary naming the affected plugins. */
function describeConflicts(conflicts) {
    const names = conflicts.slice(0, 3).map(conflict => conflict.pluginName);
    const suffix = conflicts.length > 3 ? ', …' : '';
    return `${conflicts.length} 个冲突（${names.join(', ')}${suffix}）需要先选择处理方式 / ${conflicts.length} conflict(s) (${names.join(', ')}${suffix}) need a decision`;
}
/** Convert a plan into operation warnings when changes were filtered out. */
function summarizeActions(outcomes) {
    return outcomes.filter(outcome => outcome.ok && !outcome.skipped).length;
}
/** Create the engine. */
export function createEngine(deps) {
    return new SyncEngine(deps);
}
/** The orchestration engine. */
export class SyncEngine {
    deps;
    mutex = new Mutex();
    snapshots;
    scanCache = null;
    scanInFlight = null;
    /**
     * One prepared RepoStore per configuration.
     *
     * A RepoStore prepares once (clone/fetch/reset) and then reads the local work
     * tree; creating a fresh store for every status poll made each poll run a
     * full `fetch`+`reset`, so concurrent page requests raced on the same working
     * tree and the settings page appeared to load forever. The key covers every
     * setting that changes the remote or its auth, so a configuration change
     * gets a fresh store.
     */
    repoCache = null;
    busy = false;
    lastError = null;
    dshHome;
    constructor(deps) {
        this.deps = deps;
        this.dshHome = deps.dshHome ?? join(deps.paths.dataDir, '..');
        this.snapshots = createSnapshotService({ snapshotDir: deps.paths.snapshotDir });
    }
    /** Whether an operation currently runs. */
    isBusy() {
        return this.busy || this.mutex.isPending();
    }
    /** Latest error observed by the engine (used by the status panel). */
    currentError() {
        return this.lastError;
    }
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    /** Read the status payload for the settings page. */
    async status(options = {}) {
        const config = await this.readConfig();
        let state = await this.readState();
        state = await this.persistDeviceIfChanged(state, config);
        const device = state.device;
        let local = null;
        let localError = null;
        try {
            local = await this.scanLocal(config);
        }
        catch (error) {
            localError = errorMessage(error);
        }
        let read = EMPTY_REMOTE;
        let connection = state.connection;
        if (config.repoUrl !== '') {
            const { store, workDir } = this.repoFor(config);
            const hasLocalCopy = await fileExists(workDir);
            // A poll never clones or fetches: only `refresh: true` touches the
            // network. The settings page asks for it once per load to prime a fresh
            // process, so its lists can compare against the remote side; later polls
            // read the prepared work tree. A missing local copy is not an error —
            // only the explicit refresh may report a connection failure.
            if (options.refresh === true) {
                try {
                    const prepared = await store.prepare();
                    read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
                    connection = {
                        ok: true,
                        at: new Date().toISOString(),
                        branch: config.branch,
                        head: prepared.head,
                        message: '仓库连接正常 / repository reachable',
                        authMethod: this.authMethod(config),
                    };
                }
                catch (error) {
                    connection = {
                        ok: false,
                        at: new Date().toISOString(),
                        message: errorMessage(error),
                        branch: config.branch,
                        authMethod: this.authMethod(config),
                    };
                }
            }
            else if (hasLocalCopy && store.prepared()) {
                try {
                    read = await this.readRemote(store, config, state.lastCommit, this.selfRef(state));
                }
                catch {
                    read = EMPTY_REMOTE;
                }
            }
        }
        const baseline = state.baselines[this.deps.activeProfile];
        let uploads = 0;
        let downloads = 0;
        let planConflicts = 0;
        if (local !== null) {
            const plan = planSync({
                profile: this.deps.activeProfile,
                config,
                now: new Date().toISOString(),
                localPlatform: this.deps.platform,
                local: localStates(local),
                remote: remoteStates(read),
                remoteTombstones: this.tombstonesOf(read),
                remoteMeta: remoteMeta(read),
                base: baselineStates(baseline),
                warnings: [],
            });
            const counts = countPlanChanges(plan);
            uploads = counts.uploads;
            downloads = counts.downloads;
            planConflicts = plan.conflicts.length;
        }
        const devices = read.v2 !== null
            ? read.v2.manifest.devices.map(record => ({
                id: record.id,
                name: record.name,
                platform: record.platform,
                arch: record.arch,
                dshVersion: record.dshVersion,
                pluginVersion: record.pluginVersion,
                lastSyncAt: record.lastSyncAt,
                lastResult: record.lastResult ?? 'ok',
                updatedAt: record.updatedAt,
            }))
            : Object.values(read.devices).map(snapshot => ({
                id: snapshot.device.id,
                name: snapshot.device.name,
                platform: snapshot.device.platform,
                arch: snapshot.device.arch,
                dshVersion: snapshot.device.dshVersion,
                pluginVersion: snapshot.device.pluginVersion,
                lastSyncAt: null,
                lastResult: 'ok',
                updatedAt: snapshot.updatedAt,
            }));
        devices.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const ownManifest = read.v2?.byId[device.id] ?? null;
        const repoSchemaVersion = read.v2 !== null ? 2 : read.manifest !== null || read.state !== null ? 1 : null;
        const conflictCount = Math.max(state.conflicts.length, planConflicts);
        let syncState;
        if (config.repoUrl === '')
            syncState = 'not-configured';
        else if (this.isBusy())
            syncState = 'syncing';
        else if (localError !== null)
            syncState = 'error';
        else if (conflictCount > 0)
            syncState = 'conflict';
        else if (state.lastError !== null)
            syncState = 'error';
        else if (uploads > 0 && downloads > 0)
            syncState = 'diverged';
        else if (uploads > 0)
            syncState = 'ahead';
        else if (downloads > 0)
            syncState = 'behind';
        else
            syncState = 'synced';
        const status = {
            state: syncState,
            config: this.configView(config, device),
            branch: config.branch,
            lastSyncAt: state.lastSyncAt,
            lastCommit: state.lastCommit,
            lastOperation: state.lastOperation,
            localPluginCount: local?.plugins.filter(plugin => isListedPlugin(plugin.name, plugin.builtIn)).length ?? 0,
            remotePluginCount: read.state === null
                ? null
                : Object.values(read.state.plugins)
                    .filter(entry => entry.deleted !== true && isListedPlugin(entry.name, entry.builtIn))
                    .length,
            pendingUploads: uploads,
            pendingDownloads: downloads,
            conflictCount,
            lastError: localError ?? state.lastError ?? this.lastError,
            autoSyncFailures: state.autoSyncFailures,
            busy: this.isBusy(),
            connection: connection ?? null,
            remoteDeviceCount: devices.length,
            devices,
            pendingActivation: state.pendingActivation ?? ownManifest?.status.pendingActivation ?? [],
            repoSchemaVersion,
        };
        return { status, logs: this.deps.logger.recent(50) };
    }
    /** Save configuration from the settings page. */
    async saveConfig(patch) {
        const current = await this.readConfig();
        const merged = { ...current, ...patch };
        if (patch.autoSync !== undefined)
            merged.autoSync = { ...current.autoSync, ...patch.autoSync };
        if (current.repoUrl !== (patch.repoUrl ?? current.repoUrl)) {
            // A different repository invalidates the cached connection result.
            const state = await this.readState();
            state.connection = null;
            await this.deps.stateStore.write(state);
        }
        await this.deps.configStore.write(merged);
        const config = await this.readConfig();
        const state = await this.readState();
        const next = await this.persistDeviceIfChanged(state, config);
        this.deps.onConfigChanged?.(config);
        return { config: this.configView(config, next.device) };
    }
    /** Test repository connectivity, optionally with unsaved values. */
    async testConnection(patch) {
        const current = await this.readConfig();
        const config = patch === undefined ? current : { ...current, ...patch, autoSync: current.autoSync };
        if (config.repoUrl.trim() === '') {
            throw new SyncError('not-configured', '请先填写 Git 仓库地址 / configure a repository URL first');
        }
        const { store } = this.repoFor(config);
        const result = await store.testConnection();
        const state = await this.readState();
        state.connection = result;
        await this.deps.stateStore.write(state);
        return result;
    }
    /** List deployed and repository skills without sending file contents to the page. */
    async listSkills() {
        const config = await this.readConfig();
        const state = await this.readState();
        const scanned = await scanSkills(this.dshHome);
        let remoteSkills = [];
        if (config.repoUrl.trim() !== '') {
            try {
                const { store, workDir } = this.repoFor(config);
                if ((await fileExists(workDir)) && store.prepared()) {
                    const read = await this.readRemote(store, config, state.lastCommit, this.selfRef(state));
                    remoteSkills = read.skills?.skills ?? [];
                }
            }
            catch {
                // A missing or malformed repository must not hide local skills.
            }
        }
        const localMap = new Map(scanned.backup.skills.map(skill => [skill.name, skill]));
        const remoteMap = new Map(remoteSkills.map(skill => [skill.name, skill]));
        const names = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort();
        const excluded = new Set(config.excludedSkills);
        return {
            skills: names.map(name => {
                const local = localMap.get(name);
                const remote = remoteMap.get(name);
                const present = local ?? remote;
                return {
                    name,
                    files: present?.files.length ?? 0,
                    bytes: present === undefined ? 0 : skillBytes(present),
                    syncStatus: excluded.has(name) ? 'excluded' : skillSyncStatus(local, remote),
                    presence: local !== undefined && remote !== undefined ? 'both' : local !== undefined ? 'local-only' : 'remote-only',
                };
            }),
            warnings: scanned.warnings,
        };
    }
    /** List plugins with their sync status for the settings page. */
    async listPlugins() {
        const config = await this.readConfig();
        const state = await this.readState();
        const local = await this.scanLocal(config);
        let read = EMPTY_REMOTE;
        if (config.repoUrl !== '') {
            try {
                const { store, workDir } = this.repoFor(config);
                if ((await fileExists(workDir)) && store.prepared()) {
                    read = await this.readRemote(store, config, state.lastCommit, this.selfRef(state));
                }
            }
            catch {
                read = EMPTY_REMOTE;
            }
        }
        const localMap = localStates(local);
        const remoteMap = remoteStates(read);
        const diffs = new Map();
        try {
            const plan = planSync(this.planInput(config, local, read, state));
            for (const diff of plan.diffs)
                diffs.set(diff.id, diff);
        }
        catch {
            // A malformed remote must not break the local plugin list.
        }
        const ids = [...new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])]
            // Only user-installed third-party plugins belong in the selectable
            // list: DSH built-ins are inventory-only, the DSH loader's internal
            // `cordis:*` entries are not installable plugins, and this plugin never
            // backs itself up (avoiding a self-sync loop).
            .filter(id => {
            const local = localMap[id];
            const remote = remoteMap[id];
            return isListedPlugin(local?.name ?? remote?.name ?? id, local?.builtIn === true || remote?.builtIn === true);
        })
            .sort();
        const ownManifest = read.v2?.byId[state.device.id];
        const repoSchemaVersion = read.v2 !== null ? 2 : read.manifest !== null || read.state !== null ? 1 : null;
        const rows = ids.map(id => {
            const localState = localMap[id];
            const remoteState = remoteMap[id];
            const diff = diffs.get(id);
            const conflict = diff?.conflict;
            let syncStatus = 'synced';
            if (conflict !== undefined)
                syncStatus = 'conflict';
            else if (localState !== undefined && remoteState === undefined)
                syncStatus = 'local-only';
            else if (localState === undefined && remoteState !== undefined)
                syncStatus = 'remote-only';
            else if (diff?.kind === 'version-diff')
                syncStatus = 'version-diff';
            else if (diff?.kind === 'config-diff')
                syncStatus = 'config-diff';
            else if (diff?.kind === 'enabled-diff')
                syncStatus = 'enabled-diff';
            const record = local.plugins.find(plugin => plugin.id === id);
            const entry = read.state?.plugins[id];
            const excluded = config.excludedPlugins.includes(id) || (record?.name !== undefined && config.excludedPlugins.includes(record.name));
            if (excluded)
                syncStatus = 'excluded';
            // `syncable` is the plugin's intrinsic capability; exclusion is shown by
            // `syncStatus`/`selected`. Keeping exclusion out of `syncable` is what
            // lets the UI re-enable a row the user previously excluded.
            const intrinsicallySyncable = !(record?.builtIn ?? entry?.builtIn ?? false) && (record?.syncable ?? entry?.syncable ?? true);
            const row = {
                id,
                name: record?.name ?? entry?.name ?? id,
                presence: localState !== undefined && remoteState !== undefined ? 'both' : localState !== undefined ? 'local' : 'remote',
                version: localState?.version ?? null,
                remoteVersion: remoteState?.version ?? null,
                enabled: localState?.enabled ?? false,
                remoteEnabled: remoteState?.enabled ?? null,
                syncStatus,
                inSync: diff === undefined || diff.kind === 'identical' ? !excluded : false,
                syncable: intrinsicallySyncable,
                selected: !excluded,
            };
            const ownEntry = ownManifest?.plugins[id];
            if (ownEntry !== undefined) {
                if (ownEntry.scope.mode === 'devices') {
                    const scopeDevices = [...(ownEntry.scope.devices ?? [])].sort();
                    row.scopeDevices = scopeDevices;
                    row.scopeSelfOnly = scopeDevices.length === 1 && scopeDevices[0] === state.device.id;
                }
                if (ownEntry.enabledOverride !== undefined)
                    row.enabledOverride = ownEntry.enabledOverride;
            }
            if (record?.displayName !== undefined)
                row.displayName = record.displayName;
            else if (entry?.displayName !== undefined)
                row.displayName = entry.displayName;
            if (record !== undefined)
                row.local = record;
            if (entry !== undefined)
                row.remote = entry;
            if (conflict !== undefined)
                row.conflict = true;
            if (diff !== undefined)
                row.diff = diff;
            return row;
        });
        return { rows, activeProfile: this.deps.activeProfile, availableProfiles: this.deps.availableProfiles, repoSchemaVersion };
    }
    /**
     * Update this device's declaration for one plugin.
     *
     * `scope` decides whether every device takes part or the plugin is recorded
     * as "this device only" (other devices then stop installing it and are asked
     * to remove an existing copy). `enabledOverride` only changes the enabled
     * state on this device and never affects other devices. The preference is
     * committed to the repository (creating the v2 layout on first use) so other
     * devices see it on their next synchronization.
     */
    async setPluginPreferences(update) {
        return this.mutex.runExclusive(async () => {
            this.busy = true;
            try {
                const config = await this.readConfig();
                this.ensureConfigured(config);
                let state = await this.readState();
                state = await this.persistDeviceIfChanged(state, config);
                let local = await this.scanLocal(config, true);
                const record = local.plugins.find(plugin => plugin.id === update.pluginId || plugin.name === update.pluginId);
                if (record === undefined) {
                    throw new SyncError('invalid-config', '插件未安装在本机 / plugin is not installed on this device');
                }
                if (record.builtIn || !record.syncable) {
                    throw new SyncError('invalid-config', '该插件不参与同步 / this plugin is not synchronized');
                }
                if (update.scope === undefined && update.enabledOverride === undefined) {
                    throw new SyncError('invalid-config', '没有可保存的偏好 / no preference to save');
                }
                const now = new Date().toISOString();
                const { store } = this.repoFor(config);
                const prepared = await store.prepare();
                const read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
                const previous = read.v2?.byId[state.device.id] ?? null;
                // The shared enabled vote this declaration already carried. The local
                // state follows the requested override, but the shared vote must not.
                const sharedEnabled = previous?.plugins[record.id]?.enabled ?? record.enabled;
                let targetEnabled = record.enabled;
                if (update.enabledOverride === true)
                    targetEnabled = true;
                else if (update.enabledOverride === false)
                    targetEnabled = false;
                else if (update.enabledOverride === null)
                    targetEnabled = sharedEnabled;
                if (update.enabledOverride !== undefined && targetEnabled !== record.enabled) {
                    const toggle = await this.deps.installer.setEnabled(record.id, targetEnabled, { profile: this.deps.activeProfile });
                    if (!toggle.ok)
                        throw new SyncError('install-failed', toggle.message);
                    local = await this.scanLocal(config, true);
                }
                const selfManifest = buildOwnDeviceManifest({
                    previous,
                    inventory: local,
                    profile: this.deps.activeProfile,
                    now,
                    pendingActivation: previousPendingActivation(previous),
                    lastResult: 'ok',
                    lastError: null,
                    baseCommit: prepared.head,
                });
                const entry = selfManifest.plugins[record.id];
                if (entry === undefined) {
                    throw new SyncError('invalid-config', '该插件不参与同步 / this plugin is not synchronized');
                }
                if (update.scope !== undefined) {
                    entry.scope = update.scope === 'self' ? { mode: 'devices', devices: [state.device.id] } : { mode: 'all' };
                }
                if (update.enabledOverride !== undefined) {
                    if (update.enabledOverride === null)
                        delete entry.enabledOverride;
                    else
                        entry.enabledOverride = update.enabledOverride;
                    // The shared enabled vote must not follow the device-local toggle:
                    // "disable on this device" has to leave other devices untouched.
                    entry.enabled = sharedEnabled;
                }
                entry.updatedAt = now;
                entry.updatedBy = state.device.id;
                const relativeFiles = buildV2RepoFiles({
                    read: read.v2,
                    selfManifest,
                    profile: this.deps.activeProfile,
                    pluginVersion: this.deps.pluginVersion,
                    now,
                    legacyDevices: read.v2 === null ? read.devices : undefined,
                    commit: prepared.head,
                });
                const files = {};
                for (const [relative, content] of Object.entries(relativeFiles)) {
                    files[joinRepoPath(config.backupDir, relative)] = content;
                }
                const migrating = read.v2 === null && (read.manifest !== null || read.state !== null);
                if (migrating)
                    await store.ensureMigrationTag('pre-v2-migration');
                const scopeLabel = update.scope === 'self' ? ' 仅本机 / this device only' : update.scope === 'all' ? ' 所有设备 / all devices' : '';
                const enabledLabel = update.enabledOverride === undefined
                    ? ''
                    : update.enabledOverride === null
                        ? ' 跟随全局 / follow shared'
                        : update.enabledOverride
                            ? ' 本机启用 / enabled here'
                            : ' 本机停用 / disabled here';
                const write = await store.write({
                    files,
                    deletions: [],
                    executables: [],
                    message: this.commitMessage('preferences', `${record.name}${scopeLabel}${enabledLabel}`),
                    trailers: {
                        operation: 'preferences',
                        deviceId: state.device.id,
                        deviceName: state.device.name,
                        profile: this.deps.activeProfile,
                        result: migrating ? 'migrated' : 'ok',
                        pluginCount: String(local.plugins.filter(plugin => !plugin.builtIn).length),
                    },
                });
                state.lastCommit = write.commit ?? state.lastCommit;
                state.lastError = null;
                state.lastOperation = { operation: 'preferences', at: now, ok: true, commit: write.commit, changedPlugins: 1 };
                await this.deps.stateStore.write(state);
                return await this.listPlugins();
            }
            finally {
                this.busy = false;
            }
        });
    }
    /** Compute the plan for a direction without executing anything. */
    async diff(options = {}) {
        const direction = options.direction ?? 'two-way';
        if (direction === 'push') {
            const plan = await this.previewBackup(options.signal);
            return { direction, plan };
        }
        if (direction === 'pull') {
            const preview = await this.previewRestore({ commit: options.commit, signal: options.signal });
            return { direction, plan: preview.plan };
        }
        const preview = await this.previewSync(options.signal);
        return { direction, plan: preview.plan };
    }
    /** Back up this device's plugin state to the repository. */
    async backup(options = {}) {
        return this.mutex.runExclusive(async () => {
            this.busy = true;
            const startedAt = new Date().toISOString();
            try {
                const config = await this.readConfig();
                this.ensureConfigured(config);
                let state = await this.readState();
                state = await this.persistDeviceIfChanged(state, config);
                const { store } = this.repoFor(config);
                const prepared = await store.prepare({ signal: options.signal });
                const local = await this.scanLocal(config, true);
                const read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
                const plan = this.scopedPlan(config, planBackup(this.planInput(config, local, read, state)));
                this.appendMultiDeviceBackupWarning(read, plan);
                if (plan.requiresConfirmation && options.confirmDestructive !== true) {
                    await this.persistConflicts(state, plan.conflicts);
                    throw new SyncError('confirmation-required', '备份包含删除远端记录的破坏性操作，需要确认 / the backup removes repository entries and requires confirmation', { details: { plan: safeJsonCopy(plan) } });
                }
                const scannedSkills = await this.scanSkillsFor(config);
                const remoteSkills = this.filterSkillBackup(read.skills, config);
                const skillSnapshot = config.backupScopes.skills ? mergeSkills(scannedSkills.backup, remoteSkills) : null;
                const skillsChanged = skillSnapshot !== null
                    && JSON.stringify(remoteSkills?.skills ?? []) !== JSON.stringify(skillSnapshot.skills);
                const skillsForFiles = config.backupScopes.skills
                    ? (skillSnapshot !== null && skillSnapshot.skills.length > 0 ? skillSnapshot : null)
                    : undefined;
                const pendingActivation = this.pendingActivations([], state.pendingActivation ?? [], local);
                state.pendingActivation = pendingActivation;
                const build = (currentRead, inventory) => this.buildRemoteFiles({
                    config,
                    plan,
                    local: inventory,
                    read: currentRead,
                    device: state.device,
                    baselineRead: read,
                    plugins: config.backupScopes.plugins,
                    skills: skillsForFiles,
                    previousSkills: this.filterSkillBackup(currentRead.skills, config),
                    pendingActivation,
                });
                const firstFiles = build(read, local);
                const now = new Date().toISOString();
                const repositoryHasData = read.manifest !== null || read.state !== null;
                const nothingToRecord = plan.actions.length === 0 && !skillsChanged
                    && (repositoryHasData || !config.backupScopes.skills);
                const migrating = read.v2 === null && (read.manifest !== null || read.state !== null);
                const trailers = {
                    operation: 'backup',
                    deviceId: state.device.id,
                    deviceName: state.device.name,
                    profile: this.deps.activeProfile,
                    result: migrating ? 'migrated' : plan.actions.length === 0 && !skillsChanged ? 'no-changes' : 'ok',
                    pluginCount: String(local.plugins.filter(plugin => !plugin.builtIn).length),
                };
                if (!nothingToRecord && migrating)
                    await store.ensureMigrationTag('pre-v2-migration');
                const write = nothingToRecord
                    ? { changed: false, pushed: false, commit: prepared.head, changedFiles: [], retried: false }
                    : await store.write({
                        files: firstFiles.files,
                        deletions: firstFiles.deletions,
                        executables: firstFiles.executables,
                        rebuild: async () => {
                            const freshRead = await this.readRemote(store, config, null, this.selfRef(state));
                            const freshPlan = this.scopedPlan(config, planBackup(this.planInput(config, local, freshRead, await this.readState())));
                            return this.buildRemoteFiles({
                                config,
                                plan: freshPlan,
                                local,
                                read: freshRead,
                                device: state.device,
                                baselineRead: freshRead,
                                plugins: config.backupScopes.plugins,
                                skills: skillsForFiles,
                                previousSkills: this.filterSkillBackup(freshRead.skills, config),
                                pendingActivation,
                            });
                        },
                        message: this.commitMessage('backup', options.message),
                        trailers,
                        signal: options.signal,
                    });
                const localAfter = await this.scanLocal(config, true);
                const remoteAfter = await this.readRemote(store, config, write.commit, this.selfRef(state));
                const baseline = buildBaseline({
                    profile: this.deps.activeProfile,
                    commit: write.commit ?? prepared.head,
                    now,
                    local: localStates(localAfter),
                    remote: remoteStates(remoteAfter),
                    previous: state.baselines[this.deps.activeProfile],
                });
                const outcomes = plan.actions.map(action => ({
                    action,
                    ok: true,
                    detail: write.changed ? '已写入备份仓库 / written to the backup repository' : '无变化 / no changes',
                }));
                state.lastSyncAt = now;
                state.lastCommit = write.commit ?? prepared.head;
                state.lastError = null;
                state.baselines[this.deps.activeProfile] = baseline;
                state.conflicts = [];
                state.lastOperation = {
                    operation: 'backup',
                    at: now,
                    ok: true,
                    commit: write.commit,
                    changedPlugins: plan.actions.length,
                };
                await this.recordSuccess(state);
                this.lastError = null;
                const result = {
                    ok: true,
                    operation: 'backup',
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    commit: write.commit,
                    pushed: write.pushed,
                    noChanges: !write.changed,
                    actionOutcomes: outcomes,
                    warnings: [...plan.warnings, ...scannedSkills.warnings],
                };
                this.deps.logger.info(`备份完成 / backup finished (changed=${String(write.changed)}, pushed=${String(write.pushed)})`, {
                    commit: write.commit,
                    actions: plan.actions.length,
                });
                return result;
            }
            catch (error) {
                await this.recordFailure('backup', error);
                throw error;
            }
            finally {
                this.busy = false;
            }
        }, { wait: true });
    }
    /** Preview a restore from the branch head or one commit. */
    async previewRestore(options = {}) {
        return this.mutex.runExclusive(async () => {
            const config = await this.readConfig();
            this.ensureConfigured(config);
            const state = await this.readState();
            const { store } = this.repoFor(config);
            const prepared = await store.prepare({ signal: options.signal });
            const read = options.commit === undefined || options.commit === ''
                ? await this.readRemote(store, config, prepared.head, this.selfRef(state))
                : await this.readAtCommit(store, config, options.commit);
            const local = await this.scanLocal(config);
            const plan = this.scopedPlan(config, planRestore(this.planInput(config, local, read, state)));
            return {
                plan,
                snapshotPlanned: plan.actions.some(isLocalAction),
                source: {
                    commit: options.commit === undefined || options.commit === '' ? prepared.head : options.commit,
                    updatedAt: read.state?.updatedAt ?? null,
                },
            };
        }, { wait: true });
    }
    /** Restore plugins from the repository (never deletes local extras). */
    async restore(options = {}) {
        return this.runRestore({ ...options, operation: 'restore' });
    }
    /** Restore one history commit; always takes a snapshot first. */
    async rollback(options) {
        if (options.commit.trim() === '')
            throw new SyncError('invalid-config', '缺少要恢复的提交 / a commit is required');
        return this.runRestore({ ...options, operation: 'rollback' });
    }
    /** Preview a two-way sync. */
    async previewSync(signal) {
        return this.mutex.runExclusive(async () => {
            const config = await this.readConfig();
            this.ensureConfigured(config);
            const state = await this.readState();
            const { store } = this.repoFor(config);
            const prepared = await store.prepare({ signal });
            const read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
            const local = await this.scanLocal(config);
            return { plan: this.scopedPlan(config, planSync(this.planInput(config, local, read, state))) };
        }, { wait: true });
    }
    /** Perform a two-way synchronization. */
    async sync(options = {}) {
        return this.mutex.runExclusive(async () => {
            this.busy = true;
            const startedAt = new Date().toISOString();
            let snapshotId;
            try {
                const config = await this.readConfig();
                this.ensureConfigured(config);
                let state = await this.readState();
                state = await this.persistDeviceIfChanged(state, config);
                const { store } = this.repoFor(config);
                const prepared = await store.prepare({ signal: options.signal });
                const local = await this.scanLocal(config, true);
                const read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
                const base = this.planInput(config, local, read, state);
                const plan = this.scopedPlan(config, planSync({ ...base, resolutions: options.resolutions }));
                const pending = blockingConflicts(plan, options.resolutions);
                if (pending.length > 0) {
                    await this.persistConflicts(state, pending);
                    throw new SyncError('conflict-present', describeConflicts(pending), { details: { plan: safeJsonCopy(plan) } });
                }
                const scannedSkills = await this.scanSkillsFor(config);
                const remoteSkills = this.filterSkillBackup(read.skills, config);
                const skillSnapshot = config.backupScopes.skills ? mergeSkills(scannedSkills.backup, remoteSkills) : null;
                const skillsChanged = skillSnapshot !== null
                    && JSON.stringify(remoteSkills?.skills ?? []) !== JSON.stringify(skillSnapshot.skills);
                const skillsForFiles = config.backupScopes.skills
                    ? (skillSnapshot !== null && skillSnapshot.skills.length > 0 ? skillSnapshot : null)
                    : undefined;
                if (plan.actions.length === 0 && !skillsChanged) {
                    const restoredSkills = config.backupScopes.skills
                        ? await this.tryRestoreSkills(read.skills, config)
                        : { warnings: [], restored: [] };
                    const now = new Date().toISOString();
                    state.lastSyncAt = now;
                    state.lastCommit = prepared.head;
                    state.lastError = null;
                    state.conflicts = [];
                    await this.recordSuccess(state);
                    this.lastError = null;
                    return {
                        ok: true,
                        operation: 'sync',
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        commit: prepared.head,
                        noChanges: restoredSkills.restored.length === 0,
                        actionOutcomes: [],
                        warnings: [...plan.warnings, ...scannedSkills.warnings, ...restoredSkills.warnings],
                    };
                }
                if (plan.requiresConfirmation && options.confirmDestructive !== true) {
                    await this.persistConflicts(state, plan.conflicts);
                    throw new SyncError('confirmation-required', '同步包含破坏性操作，需要确认 / the sync contains destructive actions and requires confirmation', { details: { plan: safeJsonCopy(plan) } });
                }
                const localActions = plan.actions.filter(isLocalAction);
                if (localActions.length > 0) {
                    snapshotId = await this.snapshots.create({
                        operation: 'sync',
                        profile: this.deps.activeProfile,
                        device: state.device,
                        inventory: local,
                        configs: snapshotConfigs(local, config.excludedConfigPlugins),
                    });
                }
                const outcomes = await executeLocalActions(plan.actions, {
                    installer: this.deps.installer,
                    configGateway: this.deps.configGateway,
                    logger: this.deps.logger,
                    profile: this.deps.activeProfile,
                    signal: options.signal,
                    resolveInstallSpec: async (spec) => this.resolveTarballSpec(spec, store),
                });
                const failed = outcomes.filter(outcome => !outcome.ok && outcome.skipped !== true);
                if (failed.length > 0) {
                    const rollback = snapshotId === undefined
                        ? null
                        : await this.tryRollback(snapshotId, config, state.device);
                    state.lastError = failed.map(outcome => `${outcome.action.pluginName}: ${outcome.error ?? 'failed'}`).join('; ');
                    state.lastOperation = { operation: 'sync', at: new Date().toISOString(), ok: false, error: state.lastError };
                    await this.deps.stateStore.write(state);
                    return {
                        ok: false,
                        operation: 'sync',
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        actionOutcomes: outcomes,
                        warnings: [
                            ...plan.warnings,
                            ...(rollback === null ? [] : [`已自动回滚可回滚的配置变更 / rolled back configuration: ${rollback.restoredConfigs.length}`]),
                            ...(rollback === null ? [] : rollback.notRestorablePlugins.map(plugin => `无法自动回滚插件安装 / cannot roll back install: ${plugin.name}`)),
                        ],
                        error: state.lastError,
                        snapshot: snapshotId,
                    };
                }
                const pendingActivation = this.pendingActivations(outcomes, state.pendingActivation ?? [], local);
                const pendingChanged = JSON.stringify(state.pendingActivation ?? []) !== JSON.stringify(pendingActivation);
                state.pendingActivation = pendingActivation;
                const build = (currentRead, inventory) => this.buildRemoteFiles({
                    config,
                    plan,
                    local: inventory,
                    read: currentRead,
                    device: state.device,
                    baselineRead: read,
                    plugins: config.backupScopes.plugins,
                    skills: skillsForFiles,
                    previousSkills: this.filterSkillBackup(currentRead.skills, config),
                    pendingActivation,
                });
                const firstFiles = build(read, local);
                const migrating = read.v2 === null && (read.manifest !== null || read.state !== null);
                // A local removal also updates this device's declaration (otherwise the
                // repository would keep advertising a plugin the device no longer has).
                const localRemovals = plan.actions.some(action => action.kind === 'remove-local');
                const needsWrite = plan.actions.some(action => !isLocalAction(action)) || skillsChanged || pendingChanged || localRemovals;
                if (needsWrite && migrating)
                    await store.ensureMigrationTag('pre-v2-migration');
                const write = needsWrite
                    ? await store.write({
                        files: firstFiles.files,
                        deletions: firstFiles.deletions,
                        executables: firstFiles.executables,
                        rebuild: async () => {
                            const freshRead = await this.readRemote(store, config, null, this.selfRef(state));
                            const freshPlan = this.scopedPlan(config, planSync({ ...this.planInput(config, await this.scanLocal(config, true), freshRead, state), resolutions: options.resolutions }));
                            return this.buildRemoteFiles({
                                config,
                                plan: freshPlan,
                                local: await this.scanLocal(config),
                                read: freshRead,
                                device: state.device,
                                baselineRead: freshRead,
                                plugins: config.backupScopes.plugins,
                                skills: skillsForFiles,
                                previousSkills: this.filterSkillBackup(freshRead.skills, config),
                                pendingActivation,
                            });
                        },
                        message: this.commitMessage('sync', undefined),
                        trailers: {
                            operation: 'sync',
                            deviceId: state.device.id,
                            deviceName: state.device.name,
                            profile: this.deps.activeProfile,
                            result: migrating ? 'migrated' : 'ok',
                            pluginCount: String(local.plugins.filter(plugin => !plugin.builtIn).length),
                        },
                        signal: options.signal,
                    })
                    : { changed: false, pushed: false, commit: prepared.head, changedFiles: [], retried: false };
                const localAfter = await this.scanLocal(config, true);
                const remoteAfter = await this.readRemote(store, config, write.commit, this.selfRef(state));
                const now = new Date().toISOString();
                state.baselines[this.deps.activeProfile] = buildBaseline({
                    profile: this.deps.activeProfile,
                    commit: write.commit ?? prepared.head,
                    now,
                    local: localStates(localAfter),
                    remote: remoteStates(remoteAfter),
                    previous: state.baselines[this.deps.activeProfile],
                });
                state.lastSyncAt = now;
                state.lastCommit = write.commit ?? prepared.head;
                state.lastError = null;
                state.conflicts = [];
                state.lastOperation = {
                    operation: 'sync',
                    at: now,
                    ok: true,
                    commit: write.commit,
                    changedPlugins: plan.actions.length,
                };
                await this.recordSuccess(state);
                this.lastError = null;
                const restoredSkills = config.backupScopes.skills
                    ? await this.tryRestoreSkills(read.skills, config)
                    : { warnings: [], restored: [] };
                return {
                    ok: true,
                    operation: 'sync',
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    commit: write.commit,
                    pushed: write.pushed,
                    noChanges: false,
                    actionOutcomes: outcomes,
                    warnings: [...plan.warnings, ...scannedSkills.warnings, ...restoredSkills.warnings],
                    snapshot: snapshotId,
                };
            }
            catch (error) {
                await this.recordFailure('sync', error);
                throw error;
            }
            finally {
                this.busy = false;
            }
        }, { wait: true });
    }
    /** Restore missing skills from a remote snapshot and turn problems into warnings. */
    async tryRestoreSkills(backup, config) {
        const selected = this.filterSkillBackup(backup, config);
        if (selected === null)
            return { warnings: [], restored: [] };
        try {
            const result = await restoreMissingSkills(selected, this.dshHome);
            const warnings = [...result.warnings];
            if (result.restored.length > 0)
                warnings.push(`已恢复技能 / restored skills: ${result.restored.join(', ')}`);
            return { warnings, restored: result.restored };
        }
        catch (error) {
            return { warnings: [`恢复技能失败 / cannot restore skills: ${errorMessage(error)}`], restored: [] };
        }
    }
    /** Read backup history from Git. */
    async history(options = {}) {
        const config = await this.readConfig();
        this.ensureConfigured(config);
        const state = await this.readState();
        const { store, workDir } = this.repoFor(config);
        // No local copy yet: show an empty history instead of cloning on page
        // open. The first backup/restore/sync creates the work tree.
        if (!(await fileExists(workDir)))
            return { entries: [], lastOperation: state.lastOperation };
        // A cached store is already prepared; only the first call in a process
        // prepares (and that is what may touch the network), so opening the page
        // does not fetch the remote on every request.
        const entries = await store.history({ limit: options.limit ?? 100, signal: options.signal });
        return { entries, lastOperation: state.lastOperation };
    }
    /** Record the outcome of an automatic run so the settings page can surface it. */
    async noteAutoSyncResult(ok) {
        const state = await this.readState();
        if (ok) {
            if (state.autoSyncFailures === 0)
                return;
            state.autoSyncFailures = 0;
            await this.deps.stateStore.write(state);
            return;
        }
        state.autoSyncFailures += 1;
        await this.deps.stateStore.write(state);
    }
    /** Update automatic synchronization settings. */
    async setAutoSync(patch) {
        await this.saveConfig({ autoSync: { ...(await this.readConfig()).autoSync, ...patch } });
        // The wire contract (`AutoSyncResponse`) is `{ status: StatusView }`; the
        // route used to nest the whole status payload one level deeper, so the
        // page read `response.status.config` from `undefined` after a save.
        const { status } = await this.status();
        return { status };
    }
    /** Recent log entries. */
    logs(options = {}) {
        return { entries: this.deps.logger.recent(options.limit ?? 100) };
    }
    /** Snapshot ids available for rollback. */
    listSnapshots() {
        return this.snapshots.list();
    }
    /** Roll back the configuration/enablement half of one snapshot. */
    async rollbackSnapshot(id) {
        return this.mutex.runExclusive(async () => {
            const startedAt = new Date().toISOString();
            const config = await this.readConfig();
            const state = await this.readState();
            const local = await this.scanLocal(config, true);
            const report = await this.snapshots.rollback({
                id,
                installer: this.deps.installer,
                configGateway: this.deps.configGateway,
                profile: this.deps.activeProfile,
                logger: this.deps.logger,
                currentInventory: local,
            });
            const outcomes = [];
            const warnings = [
                ...report.notRestorablePlugins.map(plugin => `无法自动回滚插件安装 / cannot roll back install: ${plugin.name} (${plugin.version ?? '?'})`),
                ...report.errors,
            ];
            state.lastOperation = {
                operation: 'rollback',
                at: new Date().toISOString(),
                ok: report.errors.length === 0,
                changedPlugins: report.restoredConfigs.length + report.restoredEnabled.length,
            };
            if (report.errors.length > 0)
                state.lastError = report.errors.join('; ');
            await this.deps.stateStore.write(state);
            return {
                ok: report.errors.length === 0,
                operation: 'rollback',
                startedAt,
                finishedAt: new Date().toISOString(),
                actionOutcomes: outcomes,
                warnings,
                snapshot: report.snapshot,
                error: report.errors.length === 0 ? undefined : report.errors.join('; '),
            };
        }, { wait: true });
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    /** Ids another device deleted: v1 tombstones plus v2 removals and deletion conflicts. */
    tombstonesOf(read) {
        const tombstones = new Set();
        for (const [id, entry] of Object.entries(read.state?.plugins ?? {})) {
            if (entry.deleted === true)
                tombstones.add(id);
        }
        if (read.v2 !== null) {
            for (const removal of read.v2.desired.removals)
                tombstones.add(removal);
            for (const conflict of read.v2.desired.conflicts) {
                if (conflict.reason === 'deleted-while-declared')
                    tombstones.add(conflict.pluginId);
            }
        }
        return tombstones;
    }
    /** Build a plan input from the current reads. */
    planInput(config, local, read, state, resolutions) {
        const tombstones = this.tombstonesOf(read);
        const warnings = [];
        if (read.v2 !== null) {
            for (const conflict of read.v2.desired.conflicts) {
                if (conflict.reason === 'deleted-while-declared') {
                    // One device removed the plugin, another still declares it. Treat it
                    // as a tombstone so the planner asks instead of resurrecting it.
                    warnings.push(`插件 ${conflict.pluginId} 存在设备间冲突：一台设备已删除，另一台仍声明 / deleted on one device but declared on another`);
                }
                else {
                    warnings.push(`插件 ${conflict.pluginId}：${conflict.detail}`);
                }
            }
            for (const blocked of read.v2.desired.blocked) {
                warnings.push(`插件 ${blocked.pluginId} 需要更新的 DSH，已跳过 / requires a newer DSH: ${blocked.reason}`);
            }
        }
        const localMap = localStates(local);
        for (const id of Object.keys(localMap)) {
            const plugin = localMap[id];
            if (plugin === undefined)
                continue;
            const excluded = config.excludedPlugins.includes(plugin.id) || config.excludedPlugins.includes(plugin.name);
            const syncable = isSyncable({ state: plugin, excludedPlugins: config.excludedPlugins, platform: this.deps.platform });
            localMap[id] = { ...plugin, syncable: syncable && !excluded };
        }
        const meta = remoteMeta(read);
        for (const [id, entry] of Object.entries(read.state?.plugins ?? {})) {
            if (entry.deleted === true)
                continue;
            const devices = read.devices[entry.updatedBy];
            if (entry.pathOnly && devices !== undefined && devices.device.platform !== this.deps.platform) {
                warnings.push(`插件 ${entry.name} 由 ${devices.device.platform} 设备归档，可能不兼容当前平台 / archived on ${devices.device.platform}`);
            }
            if (meta[id]?.platform !== undefined && meta[id].platform !== this.deps.platform && entry.origin === 'local-path') {
                // Already covered above; kept for a future per-plugin platform declaration.
            }
        }
        return {
            profile: this.deps.activeProfile,
            config,
            now: new Date().toISOString(),
            localPlatform: this.deps.platform,
            local: localMap,
            remote: remoteStates(read),
            remoteTombstones: tombstones,
            remoteMeta: meta,
            base: baselineStates(state.baselines[this.deps.activeProfile]),
            resolutions,
            warnings,
        };
    }
    /** Apply the planned local actions to an inventory (used for the written device declaration). */
    inventoryAfterPlan(local, plan, read) {
        const removed = new Set();
        const updates = new Map();
        for (const action of plan.actions) {
            if (action.kind === 'remove-local') {
                removed.add(action.pluginId);
            }
            else if (action.kind === 'install' || action.kind === 'upgrade' || action.kind === 'downgrade') {
                const remote = read.state?.plugins[action.pluginId];
                updates.set(action.pluginId, {
                    version: action.version ?? remote?.version ?? null,
                    enabled: action.enabled ?? remote?.enabled ?? true,
                    installSpec: action.installSpec ?? remote?.installSpec ?? null,
                    name: action.pluginName !== '' ? action.pluginName : remote?.name ?? action.pluginId,
                    origin: remote?.origin ?? 'npm',
                });
            }
            else if (action.kind === 'enable' || action.kind === 'disable') {
                updates.set(action.pluginId, { enabled: action.kind === 'enable' });
            }
        }
        const plugins = [];
        for (const plugin of local.plugins) {
            if (removed.has(plugin.id))
                continue;
            const update = updates.get(plugin.id);
            plugins.push(update === undefined ? plugin : { ...plugin, ...update });
        }
        for (const [id, update] of updates) {
            if (removed.has(id))
                continue;
            if (local.plugins.some(plugin => plugin.id === id))
                continue;
            plugins.push({
                id,
                name: update.name ?? id,
                version: update.version ?? null,
                origin: update.origin ?? 'npm',
                installSpec: update.installSpec ?? null,
                enabled: update.enabled ?? true,
                builtIn: false,
                syncable: true,
                pathOnly: false,
                profile: this.deps.activeProfile,
                platform: this.deps.platform,
                rows: [],
                configs: {},
                configSkipped: [],
            });
        }
        return { ...local, plugins };
    }
    /**
     * Merge the previous pending-activation list with this run's outcomes. An
     * entry is dropped once the installed inventory shows the expected version
     * (the restart happened); restart-required outcomes are added.
     */
    pendingActivations(outcomes, previous, inventory) {
        const installed = new Map();
        for (const plugin of inventory.plugins)
            installed.set(plugin.id, plugin.version ?? null);
        const pending = new Map();
        for (const entry of previous) {
            if (installed.get(entry.pluginId) === entry.version)
                continue;
            pending.set(entry.pluginId, entry);
        }
        for (const outcome of outcomes) {
            if (outcome.pendingActivation !== true)
                continue;
            const version = outcome.action.version ?? null;
            if (version === null)
                continue;
            pending.set(outcome.action.pluginId, {
                pluginId: outcome.action.pluginId,
                version,
                reason: 'restart-required',
            });
        }
        return [...pending.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    }
    /** Build the repository file set for one plan. */
    buildRemoteFiles(input) {
        const localMap = localStates(input.local);
        const upserts = new Map();
        const removals = new Set();
        const configDeletions = new Set();
        const configWrites = new Map();
        for (const action of input.plan.actions) {
            if (action.kind === 'push-plugin') {
                const state = localMap[action.pluginId];
                if (state === undefined)
                    continue;
                upserts.set(action.pluginId, { entry: toRemoteEntry(state, { deviceId: input.device.id, now: new Date().toISOString() }) });
            }
            else if (action.kind === 'push-config') {
                const existing = upserts.get(action.pluginId);
                if (existing !== undefined) {
                    existing.configs = action.configs ?? {};
                }
                else {
                    const state = localMap[action.pluginId];
                    if (state === undefined)
                        continue;
                    upserts.set(action.pluginId, {
                        entry: toRemoteEntry(state, { deviceId: input.device.id, now: new Date().toISOString() }),
                        configs: action.configs ?? {},
                    });
                }
                configWrites.set(action.pluginId, action.configs ?? {});
            }
            else if (action.kind === 'remove-remote') {
                // A propagated v2 deletion is mirrored as a v1 tombstone so an old
                // v1 mirror reader does not resurrect the plugin. A remove-local only
                // changes this device (a restriction or a remote deletion), so it is
                // not a repository-wide deletion intent.
                removals.add(action.pluginId);
            }
        }
        for (const [pluginId, configs] of configWrites) {
            if (configs === null)
                continue;
            if (Object.keys(configs).length === 0) {
                configDeletions.add(pluginId);
                const existing = upserts.get(pluginId);
                if (existing !== undefined)
                    existing.configs = undefined;
            }
            else {
                const existing = upserts.get(pluginId);
                if (existing !== undefined)
                    existing.configs = configs;
            }
        }
        const now = new Date().toISOString();
        const afterInventory = this.inventoryAfterPlan(input.local, input.plan, input.read);
        const deviceSnapshot = toDeviceSnapshot({
            device: input.device,
            profile: this.deps.activeProfile,
            now,
            plugins: afterInventory.plugins,
        });
        const knownDevices = input.read.manifest?.devices ?? input.baselineRead.manifest?.devices ?? [];
        const base = buildBackupFiles({
            backupDir: input.config.backupDir,
            generatorVersion: this.deps.pluginVersion,
            profile: this.deps.activeProfile,
            deviceId: input.device.id,
            now,
            previousManifest: input.read.manifest,
            previousState: input.read.state,
            plugins: input.plugins,
            skills: input.skills,
            previousSkills: input.previousSkills ?? this.filterSkillBackup(input.read.skills, input.config),
            upserts: [...upserts.values()],
            removals: [...removals],
            configDeletions: [...configDeletions],
            deviceSnapshot,
            knownDevices,
        });
        const previousDevice = input.read.v2?.byId[input.device.id] ?? null;
        // A remove-local never expresses this device's deletion intent: it either
        // follows another device's restriction or a deletion chosen elsewhere.
        // Recording it as "removed" here would later look like a conflicting
        // deletion when the other device still declares the plugin.
        const externalRemovals = new Set(input.plan.actions.filter(action => action.kind === 'remove-local').map(action => action.pluginId));
        const selfManifest = buildOwnDeviceManifest({
            previous: previousDevice,
            inventory: input.local,
            after: afterInventory,
            profile: this.deps.activeProfile,
            now,
            protectedIds: externalRemovals,
            pendingActivation: input.pendingActivation ?? previousPendingActivation(previousDevice),
            lastResult: input.plan.actions.length === 0 ? 'no-changes' : 'ok',
            lastError: null,
            baseCommit: input.read.head,
        });
        const legacyDevices = {};
        for (const [deviceId, snapshot] of Object.entries(input.read.devices)) {
            legacyDevices[deviceId] = { device: snapshot.device, updatedAt: snapshot.updatedAt };
        }
        const v2Files = buildV2RepoFiles({
            read: input.read.v2,
            selfManifest,
            profile: this.deps.activeProfile,
            pluginVersion: this.deps.pluginVersion,
            now,
            legacyDevices,
            commit: input.read.head,
        });
        const files = { ...base.files };
        if (input.config.backupScopes.plugins) {
            for (const [relative, content] of Object.entries(v2Files)) {
                files[joinRepoPath(input.config.backupDir, relative)] = content;
            }
        }
        return { files, deletions: base.deletions, executables: base.executables };
    }
    /** Return the cached store for this configuration, creating it on change. */
    repoFor(config) {
        const key = [
            config.repoUrl,
            config.branch,
            config.backupDir,
            config.authMode,
            config.tokenEnvVar,
            config.username,
        ].join('\u0000');
        if (this.repoCache !== null && this.repoCache.key === key)
            return this.repoCache;
        const created = this.deps.createRepo(config);
        this.repoCache = { key, ...created };
        return this.repoCache;
    }
    /** Read everything needed from the repository. */
    async readRemote(store, config, head, self) {
        let manifest = null;
        let state = null;
        let configs = {};
        let skills = null;
        let devices = {};
        let v2 = null;
        const schemaVersion = await detectRepoSchemaVersion(store).catch(() => null);
        if (schemaVersion === 2 && self !== undefined) {
            v2 = await readV2State(store, this.deps.activeProfile, self.id, self.dshVersion);
            if (v2 !== null) {
                // The v2 model is authoritative; the v1 view is derived from it.
                state = desiredRemoteState(v2, this.deps.activeProfile, new Date().toISOString());
            }
        }
        if (v2 === null) {
            try {
                manifest = await store.readManifest();
            }
            catch (error) {
                if (!isMissingRepository(error))
                    throw error;
            }
            try {
                state = await store.readProfileState(this.deps.activeProfile);
            }
            catch (error) {
                if (!isMissingRepository(error))
                    throw error;
            }
        }
        try {
            configs = await store.readConfigs(this.deps.activeProfile);
        }
        catch (error) {
            if (!isMissingRepository(error))
                throw error;
        }
        try {
            skills = await store.readSkills(this.deps.activeProfile);
        }
        catch (error) {
            if (!isMissingRepository(error))
                throw error;
        }
        try {
            devices = await store.readDeviceSnapshots();
        }
        catch {
            devices = {};
        }
        return { manifest, state, configs, skills, devices, head, v2 };
    }
    /** Identity used when reading the v2 repository model. */
    selfRef(state) {
        return { id: state.device.id, dshVersion: state.device.dshVersion };
    }
    /** Read a repository state at one commit. */
    async readAtCommit(store, config, commit) {
        if (!/^[0-9a-fA-F]{4,64}$/.test(commit)) {
            throw new SyncError('invalid-manifest', `非法提交标识 / invalid commit id: ${JSON.stringify(commit)}`);
        }
        const snapshot = await store.readAtCommit(commit, this.deps.activeProfile);
        return {
            manifest: snapshot.manifest,
            state: snapshot.state,
            configs: snapshot.configs,
            skills: snapshot.skills,
            devices: snapshot.device === null ? {} : {},
            head: commit,
            v2: null,
        };
    }
    /** Execute a restore (or history rollback) with a safety snapshot. */
    async runRestore(options) {
        return this.mutex.runExclusive(async () => {
            this.busy = true;
            const startedAt = new Date().toISOString();
            let snapshotId;
            try {
                const config = await this.readConfig();
                this.ensureConfigured(config);
                const state = await this.readState();
                const { store } = this.repoFor(config);
                const prepared = await store.prepare({ signal: options.signal });
                const read = options.commit === undefined || options.commit === ''
                    ? await this.readRemote(store, config, prepared.head, this.selfRef(state))
                    : await this.readAtCommit(store, config, options.commit);
                const local = await this.scanLocal(config, true);
                let plan = this.scopedPlan(config, planRestore(this.planInput(config, local, read, state, options.resolutions)));
                if (options.pluginIds !== undefined && options.pluginIds.length > 0) {
                    const wanted = new Set(options.pluginIds);
                    plan = { ...plan, actions: plan.actions.filter(action => wanted.has(action.pluginId)) };
                }
                const pending = blockingConflicts(plan, options.resolutions);
                if (pending.length > 0) {
                    await this.persistConflicts(state, pending);
                    throw new SyncError('conflict-present', describeConflicts(pending), { details: { plan: safeJsonCopy(plan) } });
                }
                if (plan.actions.length === 0) {
                    const skillRestore = options.operation === 'restore' && config.backupScopes.skills
                        ? await this.tryRestoreSkills(read.skills, config)
                        : { warnings: [], restored: [] };
                    state.lastOperation = { operation: options.operation, at: new Date().toISOString(), ok: true, changedPlugins: 0 };
                    await this.recordSuccess(state);
                    this.lastError = null;
                    return {
                        ok: true,
                        operation: options.operation,
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        noChanges: skillRestore.restored.length === 0,
                        actionOutcomes: [],
                        warnings: [...plan.warnings, ...skillRestore.warnings],
                    };
                }
                if (plan.requiresConfirmation && options.confirmDestructive !== true) {
                    await this.persistConflicts(state, plan.conflicts);
                    throw new SyncError('confirmation-required', '恢复包含破坏性操作，需要确认 / the restore contains destructive actions and requires confirmation', { details: { plan: safeJsonCopy(plan) } });
                }
                const skillRestore = options.operation === 'restore' && config.backupScopes.skills
                    ? await this.tryRestoreSkills(read.skills, config)
                    : { warnings: [], restored: [] };
                snapshotId = await this.snapshots.create({
                    operation: options.operation,
                    profile: this.deps.activeProfile,
                    device: state.device,
                    inventory: local,
                    configs: snapshotConfigs(local, config.excludedConfigPlugins),
                });
                const outcomes = await executeLocalActions(plan.actions, {
                    installer: this.deps.installer,
                    configGateway: this.deps.configGateway,
                    logger: this.deps.logger,
                    profile: this.deps.activeProfile,
                    signal: options.signal,
                    resolveInstallSpec: async (spec) => this.resolveTarballSpec(spec, store),
                });
                const failed = outcomes.filter(outcome => !outcome.ok && outcome.skipped !== true);
                const localAfter = await this.scanLocal(config, true);
                const now = new Date().toISOString();
                const baseline = buildBaseline({
                    profile: this.deps.activeProfile,
                    commit: plan.direction === 'pull' ? (options.commit ?? prepared.head) : prepared.head,
                    now,
                    local: localStates(localAfter),
                    remote: remoteStates(read),
                    previous: state.baselines[this.deps.activeProfile],
                });
                state.baselines[this.deps.activeProfile] = baseline;
                state.lastCommit = prepared.head;
                state.lastOperation = {
                    operation: options.operation,
                    at: now,
                    ok: failed.length === 0,
                    commit: options.commit ?? prepared.head,
                    changedPlugins: summarizeActions(outcomes),
                };
                if (failed.length === 0) {
                    state.lastSyncAt = now;
                    state.lastError = null;
                    state.conflicts = [];
                }
                else {
                    const rollback = await this.tryRollback(snapshotId, config, state.device);
                    state.lastError = failed.map(outcome => `${outcome.action.pluginName}: ${outcome.error ?? 'failed'}`).join('; ');
                    state.conflicts = plan.conflicts.map(conflict => ({ pluginId: conflict.pluginId, conflict, detectedAt: new Date().toISOString() }));
                    await this.deps.stateStore.write(state);
                    return {
                        ok: false,
                        operation: options.operation,
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        actionOutcomes: outcomes,
                        warnings: [
                            ...plan.warnings,
                            ...(rollback === null ? [] : [`已自动回滚配置变更 / configuration rolled back: ${rollback.restoredConfigs.length}`]),
                            ...(rollback === null ? [] : rollback.notRestorablePlugins.map(plugin => `无法自动回滚插件安装 / cannot roll back install: ${plugin.name}`)),
                        ],
                        error: state.lastError,
                        snapshot: snapshotId,
                    };
                }
                await this.recordSuccess(state);
                this.lastError = null;
                return {
                    ok: true,
                    operation: options.operation,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    commit: options.commit ?? prepared.head,
                    noChanges: false,
                    actionOutcomes: outcomes,
                    warnings: [...plan.warnings, ...skillRestore.warnings],
                    snapshot: snapshotId,
                };
            }
            catch (error) {
                await this.recordFailure(options.operation, error);
                throw error;
            }
            finally {
                this.busy = false;
            }
        }, { wait: true });
    }
    /** Best-effort rollback of a snapshot after a failed local operation. */
    async tryRollback(snapshotId, config, device) {
        try {
            const local = await this.scanLocal(config, true);
            return await this.snapshots.rollback({
                id: snapshotId,
                installer: this.deps.installer,
                configGateway: this.deps.configGateway,
                profile: this.deps.activeProfile,
                logger: this.deps.logger,
                currentInventory: local,
            });
        }
        catch (error) {
            this.deps.logger.error(`自动回滚失败 / automatic rollback failed: ${errorMessage(error)}`);
            return null;
        }
    }
    /** Resolve a `backup-tarball:<repo-relative path>` install spec. */
    async resolveTarballSpec(spec, store) {
        const relative = spec.slice('backup-tarball:'.length);
        const config = await this.readConfig();
        const workDir = this.repoFor(config).workDir;
        const { safeJoin } = await import('../core/paths.js');
        const absolute = safeJoin(workDir, relative.startsWith(config.backupDir) ? relative : `${config.backupDir === '' ? '' : `${config.backupDir}/`}${relative}`);
        if (!(await fileExists(absolute))) {
            throw new SyncError('install-failed', `本地插件归档不存在 / plugin archive not found: ${relative}`);
        }
        return absolute;
    }
    /** Drop plugin work when the user disabled plugin backup. */
    scopedPlan(config, plan) {
        if (config.backupScopes.plugins)
            return plan;
        return {
            ...plan,
            actions: [],
            conflicts: [],
            diffs: [],
            requiresConfirmation: false,
            localPluginCount: 0,
            remotePluginCount: 0,
            warnings: [...plan.warnings, '插件备份已关闭，本次只处理技能 / plugin backup is off; only skills are handled'],
        };
    }
    /** Scan skills only when their scope is enabled. */
    async scanSkillsFor(config) {
        if (!config.backupScopes.skills) {
            return { backup: { schemaVersion: 1, updatedAt: new Date().toISOString(), skills: [] }, warnings: [] };
        }
        const scanned = await scanSkills(this.dshHome);
        return { backup: this.filterSkillBackup(scanned.backup, config) ?? scanned.backup, warnings: scanned.warnings };
    }
    /** Drop skills the user excluded, leaving their repository copies untouched. */
    filterSkillBackup(backup, config) {
        if (backup === null)
            return null;
        const excluded = new Set(config.excludedSkills);
        if (excluded.size === 0)
            return backup;
        return { ...backup, skills: backup.skills.filter(skill => !excluded.has(skill.name)) };
    }
    /** Preview a backup (used by the diff view). */
    async previewBackup(signal) {
        const config = await this.readConfig();
        this.ensureConfigured(config);
        const state = await this.readState();
        const { store } = this.repoFor(config);
        const prepared = await store.prepare({ signal });
        const read = await this.readRemote(store, config, prepared.head, this.selfRef(state));
        const local = await this.scanLocal(config);
        const plan = planBackup(this.planInput(config, local, read, state));
        this.appendMultiDeviceBackupWarning(read, plan);
        return plan;
    }
    /**
     * Explain the multi-device caveat on backup plans.
     *
     * Backup only uploads this device; it never installs what other devices
     * published. With a v2 repository the policy can turn the notice off; with a
     * v1 repository (or no policy yet) it is always shown because there is no
     * safer default.
     */
    appendMultiDeviceBackupWarning(read, plan) {
        const deviceCount = read.v2 !== null ? read.v2.manifest.devices.length : Object.keys(read.devices).length;
        const enabled = read.v2 === null || read.v2.policy.backupButton.warnWhenMultiDevice;
        if (deviceCount <= 1 || !enabled)
            return;
        plan.warnings.push(`仓库中有 ${deviceCount} 台设备。备份只上传本机状态，不会安装其他设备的新版本；多设备请使用「同步」/ ` +
            `${deviceCount} devices share this repository. Backup only uploads this device and installs nothing; use Sync instead.`);
    }
    /** Read configuration. */
    readConfig() {
        return this.deps.configStore.read();
    }
    /** Read local state. */
    readState() {
        return this.deps.stateStore.read();
    }
    /** Keep the persisted device identity in step with configuration/versions. */
    async persistDeviceIfChanged(state, config) {
        const next = {
            ...state.device,
            name: config.deviceName,
            dshVersion: this.deps.dshVersion,
            pluginVersion: this.deps.pluginVersion,
            platform: this.deps.platform,
            arch: process.arch,
        };
        if (JSON.stringify(next) === JSON.stringify(state.device))
            return state;
        state.device = next;
        await this.deps.stateStore.write(state);
        return state;
    }
    /**
     * Drop the cached inventory: the profile's plugins changed.
     *
     * Called from the `plugin-manager/changed` listener; the next read rescans.
     */
    invalidateScan() {
        this.scanCache = null;
    }
    /**
     * Scan the local profile, with a cache shared by concurrent callers.
     *
     * The settings page fires status + plugin list together, and the status
     * poll runs every five seconds; without single-flight each of those ran a
     * full scan. A plugin-manager change invalidates the cache immediately, and
     * a forced scan (after an install/remove) bypasses it.
     */
    async scanLocal(config, force = false) {
        const now = Date.now();
        if (!force
            && this.scanCache !== null
            && this.scanCache.profile === this.deps.activeProfile
            && now - this.scanCache.at < 10_000) {
            return this.scanCache.inventory;
        }
        if (this.scanInFlight !== null)
            return this.scanInFlight;
        const run = this.deps.scanner.scan({ config, profile: this.deps.activeProfile }).then(inventory => {
            this.scanCache = { at: Date.now(), profile: this.deps.activeProfile, inventory };
            return inventory;
        });
        this.scanInFlight = run;
        try {
            return await run;
        }
        finally {
            if (this.scanInFlight === run)
                this.scanInFlight = null;
        }
    }
    /** Configuration view without secrets. */
    configView(config, device) {
        const tokenEnvVar = config.tokenEnvVar;
        return {
            ...config,
            tokenAvailable: tokenEnvVar !== '' && (this.deps.env[tokenEnvVar] ?? '') !== '',
            device,
            activeProfile: this.deps.activeProfile,
            availableProfiles: this.deps.availableProfiles,
            dataDir: displayPath(this.deps.paths.dataDir),
        };
    }
    /** Human-readable authentication method (never the secret). */
    authMethod(config) {
        if (config.authMode === 'https-token') {
            return config.tokenEnvVar === '' ? 'HTTPS token (environment variable not configured)' : `HTTPS token from $${config.tokenEnvVar}`;
        }
        if (config.authMode === 'ssh')
            return 'SSH agent / key';
        return 'system Git credential helper';
    }
    /** Throw when the repository is not configured. */
    ensureConfigured(config) {
        if (config.repoUrl.trim() === '') {
            throw new SyncError('not-configured', '尚未配置 Git 仓库地址 / no Git repository configured');
        }
    }
    /**
     * Persist the state of a successful repository operation.
     *
     * Success is the proof that the repository is reachable again, so the
     * consecutive auto-sync failure counter is cleared here. Without that, a
     * manual sync/backup/restore left the failure notice visible forever: only an
     * automatic run used to clear it, and after a pause there is no automatic run.
     */
    async recordSuccess(state) {
        state.autoSyncFailures = 0;
        await this.deps.stateStore.write(state);
        this.deps.onOperationSuccess?.();
    }
    /**
     * Persist the conflicts that still need a decision.
     *
     * A conflict-present error used to leave state.conflicts empty, so the status
     * payload disagreed with a fresh plan (the page showed no conflict while the
     * preview showed one) and a restart forgot it. Persisting the set also lets
     * the UI explain why automatic synchronization is paused.
     */
    async persistConflicts(state, conflicts) {
        const next = conflicts.map(conflict => ({
            pluginId: conflict.pluginId,
            conflict,
            detectedAt: new Date().toISOString(),
        }));
        if (JSON.stringify(next) === JSON.stringify(state.conflicts))
            return;
        state.conflicts = next;
        await this.deps.stateStore.write(state);
    }
    /** Record a failed operation in state and logs. */
    async recordFailure(operation, error) {
        const syncError = toSyncError(error);
        // A confirmation requirement is not a failure: the user simply has not
        // decided yet, and the status panel must not show an error.
        if (syncError.code === 'confirmation-required' || syncError.code === 'conflict-present') {
            this.deps.logger.info(`操作等待确认 / operation needs confirmation: ${syncError.message}`);
            return;
        }
        this.lastError = syncError.message;
        this.deps.logger.error(`操作失败 / operation failed: ${operation}: ${syncError.message}`);
        try {
            const state = await this.deps.stateStore.read();
            state.lastError = syncError.message;
            state.lastOperation = { operation, at: new Date().toISOString(), ok: false, error: syncError.message };
            await this.deps.stateStore.write(state);
        }
        catch {
            // Logging the failure is best effort; the caller still throws.
        }
    }
    /** Compose a commit message. */
    commitMessage(operation, userMessage) {
        const subject = `[dsh-plugins-git-sync] ${operation} ${this.deps.activeProfile}`;
        if (userMessage === undefined || userMessage.trim() === '')
            return subject;
        return `${subject}: ${userMessage.trim().slice(0, 200)}`;
    }
}
/** Whether an error means "the repository has no such data yet". */
function isMissingRepository(error) {
    if (error instanceof SyncError)
        return error.code === 'repo-empty';
    const message = errorMessage(error).toLowerCase();
    return message.includes('does not exist') || message.includes('not found') || message.includes('enoent');
}
