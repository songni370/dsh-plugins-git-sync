/**
 * Conversion between in-memory synchronization state and the files that live
 * in the user's backup repository.
 *
 * Absolute machine paths never cross this boundary: a `PluginRecord.localPath`
 * is stripped before serialization, and configuration values were already
 * filtered for secrets by the scanner. Every file is derived from data (never
 * copied from a directory tree), so the backup stays diff-friendly.
 * @module services/repo-files
 */
import { MAX_BACKUP_FILES, MANIFEST_SCHEMA_VERSION, PACKAGE_NAME, REPO_DEVICES_DIR, REPO_MANIFEST_FILE, REPO_PROFILES_DIR, REPO_SCHEMA_FILE, REPO_SKILLS_DIR, REPO_SKILLS_FILE } from '../constants.js';
import { SyncError } from '../core/errors.js';
import { hasControlCharacters, safeFileName } from '../core/paths.js';
import { buildManifest, buildSchemaDocument, serializeJson, serializeManifest } from '../manifest/manifest.js';
import { toBaselineEntry } from './model.js';
/**
 * Make a row's module name safe to store.
 *
 * A DSH row can name a module through an absolute `file:///…` URL (the
 * cc-safety-net bundle does this in practice). Such a value is device-specific
 * and must never reach a shared repository, so it is replaced with the plugin's
 * package name; ordinary package names and subpaths are kept.
 */
export function sanitizeModuleName(moduleName, fallbackName) {
    if (moduleName === '' || moduleName.length > 256)
        return fallbackName;
    if (/^(?:file|link|workspace):/i.test(moduleName))
        return fallbackName;
    if (/^[a-zA-Z]:[\\/]/.test(moduleName) || moduleName.startsWith('/') || moduleName.startsWith('\\'))
        return fallbackName;
    if (moduleName.includes('\\'))
        return fallbackName;
    if (hasControlCharacters(moduleName))
        return fallbackName;
    return moduleName;
}
/** Sanitize every row a backup records. */
function sanitizeRows(rows, fallbackName) {
    return rows.map(row => {
        const next = {
            ...row,
            moduleName: sanitizeModuleName(row.moduleName, fallbackName),
        };
        if (next.entryId !== undefined)
            next.entryId = sanitizeModuleName(next.entryId, '');
        if (next.entryId === '')
            delete next.entryId;
        return next;
    });
}
/** Strip machine-only fields before a plugin record enters the backup. */
export function sanitizePluginRecord(record) {
    const copy = { ...record };
    delete copy.localPath;
    copy.rows = sanitizeRows(record.rows, record.name);
    return copy;
}
/** Join repository-relative path segments with POSIX separators. */
export function joinRepoPath(...segments) {
    return segments
        .flatMap(segment => segment.split('/'))
        .filter(segment => segment !== '' && segment !== '.')
        .join('/');
}
/** Path of one profile's shared plugin state. */
export function profileStatePath(backupDir, profile) {
    return joinRepoPath(backupDir, REPO_PROFILES_DIR, profile, 'plugins.json');
}
/** Path of one profile's skills directory. */
export function skillsDirPath(backupDir, profile) {
    return joinRepoPath(backupDir, REPO_PROFILES_DIR, profile, REPO_SKILLS_DIR);
}
/** Legacy single-file skills snapshot. */
export function legacySkillsPath(backupDir, profile) {
    return joinRepoPath(backupDir, REPO_PROFILES_DIR, profile, REPO_SKILLS_FILE);
}
/** Path of one file inside a skill directory. */
export function skillFilePath(backupDir, profile, skill, relative) {
    return joinRepoPath(skillsDirPath(backupDir, profile), skill, relative);
}
/** Path of one plugin's config file. */
export function configPath(backupDir, profile, pluginId) {
    return joinRepoPath(backupDir, REPO_PROFILES_DIR, profile, 'configs', `${safeFileName(pluginId)}.json`);
}
/** Path of one device snapshot. */
export function deviceSnapshotPath(backupDir, deviceId, profile) {
    return joinRepoPath(backupDir, REPO_DEVICES_DIR, deviceId, `${safeFileName(profile)}.json`);
}
/** Build the repository entry for one plugin. */
export function toRemoteEntry(state, options) {
    const entry = {
        id: state.id,
        name: state.name,
        version: state.version,
        origin: state.origin,
        installSpec: state.installSpec,
        enabled: state.enabled,
        builtIn: state.builtIn,
        syncable: state.syncable,
        pathOnly: state.pathOnly,
        rows: sanitizeRows(state.rows, state.name),
        updatedAt: options.now,
        updatedBy: options.deviceId,
    };
    if (state.displayName !== undefined)
        entry.displayName = state.displayName;
    if (state.source !== undefined)
        entry.source = state.source;
    return entry;
}
/** Build a tombstone entry that records a deliberate removal. */
export function toTombstone(previous, state, options) {
    const base = previous ?? (state === null ? undefined : toRemoteEntry(state, options));
    const entry = {
        id: state?.id ?? previous?.id ?? 'unknown',
        name: state?.name ?? previous?.name ?? 'unknown',
        version: state?.version ?? previous?.version ?? null,
        origin: state?.origin ?? previous?.origin ?? 'unknown',
        installSpec: null,
        enabled: false,
        builtIn: false,
        syncable: true,
        pathOnly: false,
        rows: base?.rows ?? [],
        deleted: true,
        updatedAt: options.now,
        updatedBy: options.deviceId,
    };
    if (base?.displayName !== undefined)
        entry.displayName = base.displayName;
    return entry;
}
/** Build a device snapshot with machine paths stripped. */
export function toDeviceSnapshot(options) {
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        device: options.device,
        profile: options.profile,
        updatedAt: options.now,
        plugins: options.plugins.filter(plugin => !plugin.builtIn).map(sanitizePluginRecord),
    };
}
/** Build a profile state document from its entries. */
export function toProfileState(profile, now, entries) {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, profile, updatedAt: now, plugins: entries };
}
/** Build a config file document. */
export function toConfigEntry(pluginId, configs, options) {
    return { pluginId, updatedAt: options.now, updatedBy: options.deviceId, configs };
}
/** Constant README explaining what the repository is and must not contain. */
function backupReadme() {
    return `# DSH 插件 Git 同步备份 / DSH Plugin Git Sync backup

本仓库由 **DSH 插件 Git 同步 / DSH Plugin Git Sync**（\`${PACKAGE_NAME}\`）自动写入。
This repository is written automatically by **DSH Plugin Git Sync** (\`${PACKAGE_NAME}\`).

- 请勿手动修改这些文件；下次同步会按清单格式校验，非法内容会被拒绝。
  Do not edit these files by hand: the next sync validates them and rejects malformed input.
- 这里只保存插件清单、版本、来源和已部署技能文件；**不会**保存插件配置、Token、密码、私钥、Cookie 或机器绝对路径。
  Only plugin inventory, versions, sources, enablement and the deployed DSH skills are stored here. Plugin configuration, Agent presets and UI settings are never written. Tokens, passwords, private keys, cookies and machine paths are never written.
- 恢复前请在「DSH 插件 Git 同步」设置页查看预览；破坏性操作需要确认。
  Preview restores in the "DSH Plugin Git Sync" settings page; destructive operations require confirmation.

目录结构 / layout:

\`\`\`text
manifest.json                          schema version, per-profile plugin counts, devices
metadata/schema.json                   machine-readable description of this layout
profiles/<profile>/plugins.json        shared desired plugin state (with tombstones)
profiles/<profile>/skills/<name>/...    deployed DSH skills, as real files
profiles/<profile>/configs/<id>.json   legacy filtered plugin configuration (no longer written)
devices/<deviceId>/<profile>.json      last published inventory of one device
\`\`\`
`;
}
/** Decode one in-memory skill file to repository content. */
function skillFileContent(file) {
    return file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content;
}
/** Every repository path of an in-memory skill snapshot. */
function skillFilePaths(backupDir, profile, backup) {
    const out = new Set();
    for (const skill of backup?.skills ?? []) {
        for (const file of skill.files)
            out.add(skillFilePath(backupDir, profile, skill.name, file.path));
    }
    return out;
}
/** Build every file a backup/sync writes, plus the paths to delete. */
export function buildBackupFiles(input) {
    const entries = { ...(input.previousState?.plugins ?? {}) };
    const configs = {};
    for (const { entry, configs: entryConfigs } of input.upserts) {
        entries[entry.id] = entry;
        if (entryConfigs !== undefined) {
            configs[entry.id] = toConfigEntry(entry.id, entryConfigs, { deviceId: input.deviceId, now: input.now });
        }
    }
    const includePlugins = input.plugins !== false;
    const deletions = [];
    if (includePlugins) {
        for (const pluginId of input.removals) {
            entries[pluginId] = toTombstone(entries[pluginId], null, { deviceId: input.deviceId, now: input.now });
            delete configs[pluginId];
            deletions.push(configPath(input.backupDir, input.profile, pluginId));
        }
        for (const pluginId of input.configDeletions ?? []) {
            delete configs[pluginId];
            deletions.push(configPath(input.backupDir, input.profile, pluginId));
        }
    }
    const activeEntries = Object.values(entries).filter(entry => entry.deleted !== true);
    const devices = [...new Set([...input.knownDevices, input.deviceId])].sort();
    const manifest = buildManifest({
        generatorVersion: input.generatorVersion,
        previous: input.previousManifest,
        profiles: {
            ...(input.previousManifest?.profiles ?? {}),
            [input.profile]: { pluginCount: activeEntries.length, updatedAt: input.now },
        },
        devices,
        now: input.now,
    });
    const legacySkillFile = legacySkillsPath(input.backupDir, input.profile);
    const files = {};
    const executables = [];
    const nextSkillPaths = new Set();
    if (input.skills !== undefined) {
        // Once a tree is written, the legacy single-file snapshot is obsolete.
        deletions.push(legacySkillFile);
        for (const skill of input.skills?.skills ?? []) {
            for (const file of skill.files) {
                const path = skillFilePath(input.backupDir, input.profile, skill.name, file.path);
                nextSkillPaths.add(path);
                files[path] = skillFileContent(file);
                if (file.executable === true)
                    executables.push(path);
            }
        }
        for (const previous of skillFilePaths(input.backupDir, input.profile, input.previousSkills)) {
            if (!nextSkillPaths.has(previous))
                deletions.push(previous);
        }
    }
    if (includePlugins) {
        files[joinRepoPath(input.backupDir, REPO_MANIFEST_FILE)] = serializeManifest(manifest);
        files[joinRepoPath(input.backupDir, REPO_SCHEMA_FILE)] = buildSchemaDocument(input.generatorVersion);
        files[joinRepoPath(input.backupDir, 'README.md')] = backupReadme();
        files[profileStatePath(input.backupDir, input.profile)] = serializeJson(toProfileState(input.profile, input.now, entries));
        files[deviceSnapshotPath(input.backupDir, input.deviceId, input.profile)] = serializeJson({
            ...input.deviceSnapshot,
            plugins: input.deviceSnapshot.plugins.map(sanitizePluginRecord),
        });
        for (const [pluginId, config] of Object.entries(configs)) {
            files[configPath(input.backupDir, input.profile, pluginId)] = serializeJson(config);
        }
    }
    if (Object.keys(files).length > MAX_BACKUP_FILES) {
        throw new SyncError('internal', `备份文件数量超过上限 ${MAX_BACKUP_FILES} / backup file count exceeds the limit`);
    }
    return { files, deletions, executables };
}
/** Build a baseline from converged local/remote state maps. */
export function buildBaseline(options) {
    const plugins = {};
    const ids = new Set([...Object.keys(options.local), ...Object.keys(options.remote), ...Object.keys(options.previous?.plugins ?? {})]);
    for (const id of ids) {
        const local = options.local[id] ?? null;
        const remote = options.remote[id] ?? null;
        if (local !== null && remote !== null && local.version === remote.version && local.enabled === remote.enabled
            && serializeJson(local.configs) === serializeJson(remote.configs)) {
            plugins[id] = toBaselineEntry(local);
            continue;
        }
        if (local === null && remote === null)
            continue;
        const previous = options.previous?.plugins[id];
        if (previous !== undefined)
            plugins[id] = previous;
    }
    return {
        profile: options.profile,
        commit: options.commit,
        updatedAt: options.now,
        plugins,
    };
}
/** Serialize a plugin state map (used by tests and snapshots). */
export function serializeStates(states) {
    return serializeJson(states);
}
