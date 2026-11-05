import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mergeSkills,
  restoreMissingSkills,
  sameSkill,
  scanSkills,
  skillBytes,
  skillSyncStatus,
  validateSkillBackup,
} from '../../src/skills/skills.js'

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-skills-'))
}

describe('skills backup', () => {
  it('captures deployed skill files, ignores VCS noise, and reports binary safely', async () => {
    const home = await tempHome()
    const skill = join(home, 'skills', 'demo')
    await mkdir(join(skill, '.git'), { recursive: true })
    await mkdir(join(skill, 'bin'), { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '# Demo\n')
    await writeFile(join(skill, 'bin', 'run'), '#!/bin/sh\necho hi\n')
    await chmod(join(skill, 'bin', 'run'), 0o755)
    await writeFile(join(skill, 'logo.bin'), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(skill, '.git', 'config'), 'private')
    await symlink(join(home, 'outside'), join(skill, 'linked'))

    const { backup, warnings } = await scanSkills(home, '2026-01-01T00:00:00.000Z')
    expect(backup.skills.map(item => item.name)).toEqual(['demo'])
    const files = backup.skills[0]!.files
    expect(files.map(file => file.path)).toEqual(['SKILL.md', 'bin/run', 'logo.bin'])
    expect(files.find(file => file.path === 'SKILL.md')?.content).toBe('# Demo\n')
    expect(files.find(file => file.path === 'bin/run')?.executable).toBe(true)
    expect(files.find(file => file.path === 'logo.bin')?.encoding).toBe('base64')
    expect(warnings.some(line => line.includes('符号链接'))).toBe(true)
  })

  it('returns an empty snapshot when the skills directory is absent', async () => {
    const home = await tempHome()
    const { backup } = await scanSkills(home)
    expect(backup.skills).toEqual([])
  })

  it('merges local skills over remote ones and preserves remote-only skills', () => {
    const local = {
      schemaVersion: 1 as const,
      updatedAt: 'local',
      skills: [{ name: 'beta', files: [{ path: 'SKILL.md', content: 'local', encoding: 'utf8' as const }] }],
    }
    const remote = {
      schemaVersion: 1 as const,
      updatedAt: 'remote',
      skills: [
        { name: 'alpha', files: [{ path: 'SKILL.md', content: 'remote', encoding: 'utf8' as const }] },
        { name: 'beta', files: [{ path: 'SKILL.md', content: 'old', encoding: 'utf8' as const }] },
      ],
    }
    const merged = mergeSkills(local, remote)
    expect(merged.updatedAt).toBe('local')
    expect(merged.skills.map(skill => skill.name)).toEqual(['alpha', 'beta'])
    expect(merged.skills[1]!.files[0]!.content).toBe('local')
  })

  it('restores only missing skills and never overwrites an existing one', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'skills', 'existing'), { recursive: true })
    await writeFile(join(home, 'skills', 'existing', 'SKILL.md'), 'keep me')
    const backup = {
      schemaVersion: 1 as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
      skills: [
        { name: 'existing', files: [{ path: 'SKILL.md', content: 'replace?', encoding: 'utf8' as const }] },
        { name: 'new-skill', files: [
          { path: 'SKILL.md', content: 'hello', encoding: 'utf8' as const },
          { path: 'bin/run', content: '#!/bin/sh\n', encoding: 'utf8' as const, executable: true },
        ] },
      ],
    }
    const result = await restoreMissingSkills(backup, home)
    expect(result.restored).toEqual(['new-skill'])
    expect(result.skipped).toEqual(['existing'])
    expect(await readFile(join(home, 'skills', 'existing', 'SKILL.md'), 'utf8')).toBe('keep me')
    expect(await readFile(join(home, 'skills', 'new-skill', 'SKILL.md'), 'utf8')).toBe('hello')
    expect((await stat(join(home, 'skills', 'new-skill', 'bin', 'run'))).mode & 0o111).not.toBe(0)
  })

  it('classifies backup status by local and repository copies', () => {
    const local = { name: 'demo', files: [{ path: 'SKILL.md', content: 'local', encoding: 'utf8' as const }] }
    const same = { name: 'demo', files: [{ path: 'SKILL.md', content: 'local', encoding: 'utf8' as const }] }
    const remote = { name: 'demo', files: [{ path: 'SKILL.md', content: 'remote', encoding: 'utf8' as const }] }
    expect(sameSkill(local, same)).toBe(true)
    expect(sameSkill(local, remote)).toBe(false)
    expect(skillSyncStatus(local, same)).toBe('synced')
    expect(skillSyncStatus(local, undefined)).toBe('local-only')
    expect(skillSyncStatus(undefined, remote)).toBe('remote-only')
    expect(skillSyncStatus(local, remote)).toBe('modified')
    expect(skillBytes(remote)).toBe(6)
  })

  it('rejects unsafe skill documents', () => {
    expect(() => validateSkillBackup({ schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', skills: [{ name: '../escape', files: [] }] })).toThrow()
    expect(() => validateSkillBackup({ schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', skills: [{ name: 'ok', files: [{ path: '../x', content: '', encoding: 'utf8' }] }] })).toThrow()
    expect(() => validateSkillBackup({ schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', skills: [{ name: 'ok', files: [{ path: 'a', content: '', encoding: 'binary' }] }] })).toThrow()
  })
})
