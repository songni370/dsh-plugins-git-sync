/**
 * Field-level three-way merge for plugin configuration.
 *
 * Plugin configuration is stored as one JSON object per plugin. Comparing the
 * whole object makes two devices conflict even when they changed different
 * settings, so this module merges the object key by key against the last
 * synchronized baseline:
 *
 * - only this device changed a key → keep the local value
 * - only another device changed it → take the remote value
 * - both changed it to the same value → keep it
 * - both changed it differently → report that key as a real conflict
 *
 * A missing key and an explicit `null` are different values: removing a key is
 * a change just like assigning a new value. Only the top level of the object is
 * merged — a nested object is still one value, because its schema is owned by
 * the plugin and cannot be merged safely without knowing that schema.
 * @module services/config-merge
 */
import { deepEqual } from '../core/json.js';
/** Read an own property, distinguishing a missing key from `null`. */
function read(object, key) {
    if (object === null || object === undefined)
        return undefined;
    return Object.hasOwn(object, key) ? object[key] : undefined;
}
/**
 * Merge two config maps against the baseline they last agreed on.
 *
 * The caller must only use `merged` when `conflicts` is empty. When one side
 * deleted a key and the other changed it, that is a conflict as well: choosing
 * a side is a semantic decision, not something to guess.
 */
export function mergeConfigs(base, local, remote) {
    const keys = new Set([
        ...Object.keys(base ?? {}),
        ...Object.keys(local ?? {}),
        ...Object.keys(remote ?? {}),
    ]);
    const merged = {};
    const conflicts = [];
    const localKeys = [];
    const remoteKeys = [];
    for (const key of [...keys].sort()) {
        const baseValue = read(base, key);
        const localValue = read(local, key);
        const remoteValue = read(remote, key);
        const localChanged = !deepEqual(localValue, baseValue);
        const remoteChanged = !deepEqual(remoteValue, baseValue);
        if (localChanged && remoteChanged) {
            if (deepEqual(localValue, remoteValue)) {
                if (localValue !== undefined)
                    merged[key] = localValue;
            }
            else {
                conflicts.push(key);
            }
            continue;
        }
        if (localChanged) {
            if (localValue !== undefined) {
                merged[key] = localValue;
                localKeys.push(key);
            }
            continue;
        }
        if (remoteChanged) {
            if (remoteValue !== undefined) {
                merged[key] = remoteValue;
                remoteKeys.push(key);
            }
            continue;
        }
        if (baseValue !== undefined)
            merged[key] = baseValue;
    }
    return { merged, conflicts, localKeys, remoteKeys };
}
