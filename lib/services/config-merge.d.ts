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
import type { JsonObject } from '../types.js';
/** Result of merging local and remote config against a baseline. */
export interface ConfigMergeResult {
    /**
     * Merged object. It contains every non-conflicting key and is only safe to
     * apply when {@link conflicts} is empty.
     */
    merged: JsonObject;
    /** Top-level keys changed differently on both sides, sorted. */
    conflicts: string[];
    /** Keys whose merged value came from the local side, sorted. */
    localKeys: string[];
    /** Keys whose merged value came from the remote side, sorted. */
    remoteKeys: string[];
}
/**
 * Merge two config maps against the baseline they last agreed on.
 *
 * The caller must only use `merged` when `conflicts` is empty. When one side
 * deleted a key and the other changed it, that is a conflict as well: choosing
 * a side is a semantic decision, not something to guess.
 */
export declare function mergeConfigs(base: JsonObject | null | undefined, local: JsonObject | null | undefined, remote: JsonObject | null | undefined): ConfigMergeResult;
