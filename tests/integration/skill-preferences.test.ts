/**
 * Per-device skill preferences: install scope and local install/uninstall.
 *
 * The repository records whether every device should have a skill or only this
 * device. Removing a skill locally never propagates to other devices and is not
 * undone automatically, while an explicit install brings it back from the
 * repository.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBareRepo, createFakeDevice, repoCommitCount, type FakeDevice } from './fake-dsh.js'

interface Ctx {
  root: string
  bareRepo: string
  mac: FakeDevice
  win: FakeDevice
}

async function writeSkill(device: FakeDevice, name: string, body: string): Promise<void> {
  const dir = join(device.root, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), body, 'utf8')
}

async function hasSkill(device: FakeDevice, name: string): Promise<boolean> {
  try {
    await access(join(device.root, 'skills', name))
    return true
  } catch {
    return false
  }
}

describe('per-device skill preferences', () => {
  let ctx: Ctx

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-prefs-'))
    const bareRepo = await createBareRepo(root)
    const mac = await createFakeDevice({ root, name: 'mac', repoUrl: bareRepo })
    const win = await createFakeDevice({ root, name: 'win', repoUrl: bareRepo, platform: 'win32' })
    ctx = { root, bareRepo, mac, win }
  })

  afterEach(async () => {
    await rm(ctx.root, { recursive: true, force: true })
  })

  it('keeps a skill on one device and restores it after the restriction clears', async () => {
    await writeSkill(ctx.mac, 'alpha', '# Alpha\n')
    expect((await ctx.mac.engine.backup()).ok).toBe(true)
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)
    expect(await hasSkill(ctx.win, 'alpha')).toBe(true)

    const before = repoCommitCount(ctx.bareRepo)
    const listed = await ctx.mac.engine.setSkillPreferences({ skillName: 'alpha', scope: 'self' })
    const row = listed.skills.find(skill => skill.name === 'alpha')
    expect(row?.scopeSelfOnly).toBe(true)
    expect(repoCommitCount(ctx.bareRepo)).toBe(before + 1)

    // The other device keeps its installed copy but the repository no longer
    // offers it there; after removing it locally a sync must not bring it back.
    await rm(join(ctx.win.root, 'skills', 'alpha'), { recursive: true, force: true })
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)
    expect(await hasSkill(ctx.win, 'alpha')).toBe(false)

    await ctx.mac.engine.setSkillPreferences({ skillName: 'alpha', scope: 'all' })
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)
    expect(await hasSkill(ctx.win, 'alpha')).toBe(true)
  })

  it('uninstalls a skill on this device only and keeps it removed on sync', async () => {
    await writeSkill(ctx.mac, 'beta', '# Beta\n')
    expect((await ctx.mac.engine.backup()).ok).toBe(true)
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)

    const before = repoCommitCount(ctx.bareRepo)
    const listed = await ctx.win.engine.setSkillPreferences({ skillName: 'beta', action: 'uninstall' })
    const row = listed.skills.find(skill => skill.name === 'beta')
    expect(row?.installed).toBe(false)
    expect(row?.deletedHere).toBe(true)
    expect(repoCommitCount(ctx.bareRepo)).toBe(before + 1)

    // The other device is untouched, and a sync does not restore the local removal.
    expect((await ctx.mac.engine.listSkills()).skills.find(skill => skill.name === 'beta')?.installed).toBe(true)
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)
    expect(await hasSkill(ctx.win, 'beta')).toBe(false)

    const reinstalled = await ctx.win.engine.setSkillPreferences({ skillName: 'beta', action: 'install' })
    expect(reinstalled.skills.find(skill => skill.name === 'beta')?.installed).toBe(true)
    expect(await hasSkill(ctx.win, 'beta')).toBe(true)
  })

  it('applies a batch of skill preferences in one commit', async () => {
    await writeSkill(ctx.mac, 'alpha', '# Alpha\n')
    await writeSkill(ctx.mac, 'beta', '# Beta\n')
    expect((await ctx.mac.engine.backup()).ok).toBe(true)
    expect((await ctx.win.engine.sync({ confirmDestructive: true })).ok).toBe(true)

    const before = repoCommitCount(ctx.bareRepo)
    const listed = await ctx.win.engine.setSkillPreferencesBatch([
      { skillName: 'alpha', action: 'uninstall' },
      { skillName: 'beta', scope: 'self' },
    ])
    expect(repoCommitCount(ctx.bareRepo)).toBe(before + 1)
    expect(listed.skills.find(skill => skill.name === 'alpha')?.deletedHere).toBe(true)
    expect(listed.skills.find(skill => skill.name === 'beta')?.scopeSelfOnly).toBe(true)
    expect(await hasSkill(ctx.win, 'alpha')).toBe(false)
    expect(await hasSkill(ctx.win, 'beta')).toBe(true)
  })
})
