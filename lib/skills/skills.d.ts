/**
 * Back up and restore the DSH skills a user deployed under `~/.dsh/skills`.
 *
 * Skills are often symlinks into a skills manager. We deliberately read the
 * target content instead of storing the link, because a link is useless on
 * another device. Only the deployed entries are captured; the manager's
 * database, cache, `.git` metadata and undeployed skills are outside this
 * snapshot.
 * @module skills/skills
 */
import type { SkillBackup } from '../types.js';
/** Result of scanning the local skills directory. */
export interface ScannedSkills {
    backup: SkillBackup;
    warnings: string[];
}
/** Whether a name can safely become a child directory of `~/.dsh/skills`. */
export declare function isSafeSkillName(value: string): boolean;
/** Capture the deployed skills. Never throws for an absent directory. */
export declare function scanSkills(dshHome: string, now?: string): Promise<ScannedSkills>;
/**
 * Combine a local snapshot with the repository copy.
 *
 * Local content wins for a skill that exists on both sides; a remote-only skill
 * is preserved. This makes backup additive: deleting a skill on one device does
 * not erase the copy other devices still rely on.
 */
export declare function mergeSkills(local: SkillBackup, remote: SkillBackup | null): SkillBackup;
/** Result of restoring a skill snapshot. */
export interface RestoredSkills {
    restored: string[];
    skipped: string[];
    warnings: string[];
}
/**
 * Restore only skills missing on this device.
 *
 * Never overwrite an existing skill: a local edit is more valuable than
 * silently replacing it, and a real merge is not well-defined for arbitrary
 * files. Existing and restored skills are reported separately.
 */
export declare function restoreMissingSkills(backup: SkillBackup | null, dshHome: string): Promise<RestoredSkills>;
/** Validate a decoded skills document from the repository. */
export declare function validateSkillBackup(value: unknown): SkillBackup;
