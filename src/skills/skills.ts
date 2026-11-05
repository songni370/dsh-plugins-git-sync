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

import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncError } from '../core/errors.js'
import { isSafeRelativePath } from '../core/paths.js'
import type { SkillBackup, SkillEntry, SkillFileRecord } from '../types.js'

/** A skill directory name must be a single, conservative path segment. */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Skip build/VCS noise; these are not part of the skill itself. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_FILES_PER_SKILL = 2_000

/** Result of scanning the local skills directory. */
export interface ScannedSkills {
  backup: SkillBackup
  warnings: string[]
}

/** Whether a name can safely become a child directory of `~/.dsh/skills`. */
export function isSafeSkillName(value: string): boolean {
  return SKILL_NAME_PATTERN.test(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Encode a file as UTF-8 text when lossless, otherwise base64. */
function encodeFile(data: Buffer): { content: string; encoding: SkillFileRecord['encoding'] } {
  if (!data.includes(0)) {
    const text = data.toString('utf8')
    if (Buffer.from(text, 'utf8').equals(data)) return { content: text, encoding: 'utf8' }
  }
  return { content: data.toString('base64'), encoding: 'base64' }
}

/** Read every file under one deployed skill directory. */
async function scanSkill(root: string, warnings: string[]): Promise<SkillFileRecord[]> {
  const files: SkillFileRecord[] = []
  let total = 0
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      warnings.push(`无法读取技能目录 / cannot read skill directory: ${relative || '.'}`)
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const nextRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`跳过技能内的符号链接 / skipped a symlink inside a skill: ${nextRelative}`)
        continue
      }
      if (entry.isDirectory()) {
        await walk(full, nextRelative)
        continue
      }
      if (!entry.isFile()) continue
      if (!isSafeRelativePath(nextRelative)) {
        warnings.push(`跳过不安全的技能路径 / skipped an unsafe skill path: ${nextRelative}`)
        continue
      }
      if (files.length >= MAX_FILES_PER_SKILL) {
        warnings.push(`技能文件过多，已截断 / too many files in a skill, truncated: ${relative || '.'}`)
        return
      }
      let data: Buffer
      try {
        const stat = await lstat(full)
        if (stat.size > MAX_FILE_BYTES) {
          warnings.push(`跳过超大技能文件 / skipped a large skill file: ${nextRelative}`)
          continue
        }
        data = await readFile(full)
      } catch {
        warnings.push(`无法读取技能文件 / cannot read skill file: ${nextRelative}`)
        continue
      }
      if (total + data.byteLength > MAX_TOTAL_BYTES) {
        warnings.push('技能总大小超过上限，后续文件已跳过 / skills exceed the total size limit')
        return
      }
      total += data.byteLength
      const { content, encoding } = encodeFile(data)
      const record: SkillFileRecord = { path: nextRelative, content, encoding }
      try {
        const stat = await lstat(full)
        if ((stat.mode & 0o111) !== 0) record.executable = true
      } catch {
        // The mode is advisory; keep the file.
      }
      files.push(record)
    }
  }
  await walk(root, '')
  return files
}

/** Capture the deployed skills. Never throws for an absent directory. */
export async function scanSkills(dshHome: string, now = new Date().toISOString()): Promise<ScannedSkills> {
  const warnings: string[] = []
  const root = join(dshHome, 'skills')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { backup: { schemaVersion: 1, updatedAt: now, skills: [] }, warnings }
  }
  const skills: SkillEntry[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isFile()) continue
    if (!isSafeSkillName(entry.name)) {
      warnings.push(`跳过名称不安全的技能 / skipped an unsafe skill name: ${entry.name}`)
      continue
    }
    const files = await scanSkill(join(root, entry.name), warnings)
    if (files.length === 0) {
      warnings.push(`技能没有可备份的文件 / skill has no files: ${entry.name}`)
      continue
    }
    skills.push({ name: entry.name, files })
  }
  return { backup: { schemaVersion: 1, updatedAt: now, skills }, warnings }
}

/**
 * Combine a local snapshot with the repository copy.
 *
 * Local content wins for a skill that exists on both sides; a remote-only skill
 * is preserved. This makes backup additive: deleting a skill on one device does
 * not erase the copy other devices still rely on.
 */
export function mergeSkills(local: SkillBackup, remote: SkillBackup | null): SkillBackup {
  if (remote === null) return local
  const merged = new Map(remote.skills.map(skill => [skill.name, skill]))
  for (const skill of local.skills) merged.set(skill.name, skill)
  return {
    schemaVersion: local.schemaVersion,
    updatedAt: local.updatedAt,
    skills: [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }
}

/** Result of restoring a skill snapshot. */
export interface RestoredSkills {
  restored: string[]
  skipped: string[]
  warnings: string[]
}

/**
 * Restore only skills missing on this device.
 *
 * Never overwrite an existing skill: a local edit is more valuable than
 * silently replacing it, and a real merge is not well-defined for arbitrary
 * files. Existing and restored skills are reported separately.
 */
export async function restoreMissingSkills(backup: SkillBackup | null, dshHome: string): Promise<RestoredSkills> {
  const restored: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  if (backup === null) return { restored, skipped, warnings }
  const root = join(dshHome, 'skills')
  await mkdir(root, { recursive: true })
  for (const skill of backup.skills) {
    if (!isSafeSkillName(skill.name)) {
      warnings.push(`跳过名称不安全的技能 / skipped an unsafe skill name: ${skill.name}`)
      continue
    }
    const target = join(root, skill.name)
    if (await pathExists(target)) {
      skipped.push(skill.name)
      continue
    }
    const dir = join(root, skill.name)
    await mkdir(dir, { recursive: true })
    for (const file of skill.files) {
      if (!isSafeRelativePath(file.path)) {
        warnings.push(`跳过不安全的技能路径 / skipped an unsafe skill path: ${skill.name}/${file.path}`)
        continue
      }
      const destination = join(dir, file.path)
      await mkdir(join(destination, '..'), { recursive: true })
      const data = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8')
      await writeFile(destination, data, { mode: file.executable === true ? 0o755 : 0o644 })
    }
    restored.push(skill.name)
  }
  return { restored, skipped, warnings }
}

/** Validate a decoded skills document from the repository. */
export function validateSkillBackup(value: unknown): SkillBackup {
  const fail = (reason: string): never => {
    throw new SyncError('invalid-manifest', `skills.json 无效 / invalid skills.json: ${reason}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象 / must be an object')
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1) fail('schemaVersion 必须为 1 / schemaVersion must be 1')
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) {
    fail('updatedAt 必须是 ISO-8601 时间 / updatedAt must be an ISO-8601 timestamp')
  }
  if (!Array.isArray(raw.skills)) fail('skills 必须是数组 / skills must be an array')
  const rawSkills = raw.skills as unknown[]
  if (rawSkills.length > 500) fail('技能数量超过上限 / too many skills')
  const seen = new Set<string>()
  const skills: SkillEntry[] = []
  for (const item of rawSkills) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail('技能条目必须是对象 / skill entry must be an object')
    const skill = item as Record<string, unknown>
    if (typeof skill.name !== 'string' || !isSafeSkillName(skill.name)) fail('技能名称不合法 / invalid skill name')
    const name = skill.name as string
    if (seen.has(name)) fail(`技能重复 / duplicate skill: ${name}`)
    seen.add(name)
    if (!Array.isArray(skill.files)) fail('技能 files 必须是数组 / skill files must be an array')
    const rawFiles = skill.files as unknown[]
    const files: SkillFileRecord[] = []
    for (const rawFile of rawFiles) {
      if (rawFile === null || typeof rawFile !== 'object' || Array.isArray(rawFile)) fail('技能文件必须是对象 / skill file must be an object')
      const file = rawFile as Record<string, unknown>
      if (typeof file.path !== 'string' || !isSafeRelativePath(file.path)) fail('技能文件路径不合法 / invalid skill file path')
      const path = file.path as string
      if (typeof file.content !== 'string') fail('技能文件内容必须是字符串 / skill file content must be a string')
      const content = file.content as string
      if (file.encoding !== 'utf8' && file.encoding !== 'base64') fail('技能文件编码不合法 / invalid skill file encoding')
      const encoding = file.encoding as SkillFileRecord['encoding']
      if (encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) fail('技能文件 base64 不合法 / invalid base64')
      const record: SkillFileRecord = { path, content, encoding }
      if (file.executable === true) record.executable = true
      files.push(record)
    }
    skills.push({ name, files })
  }
  return { schemaVersion: 1, updatedAt: raw.updatedAt as string, skills }
}
