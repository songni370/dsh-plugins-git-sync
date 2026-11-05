/** Skill card starts collapsed and paginates its rows. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillsSection } from '../../client/src/ui/SkillsSection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { SkillListResponse } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

const skills: SkillListResponse = {
  skills: Array.from({ length: 12 }, (_, index) => ({
    name: `skill-${index}`,
    files: index + 1,
    bytes: (index + 1) * 1024,
    syncStatus: 'synced',
  })),
  warnings: [],
}

describe('skill card', () => {
  it('starts collapsed', () => {
    const html = renderToStaticMarkup(
      <SkillsSection t={t} skills={skills} loading={false} error={null} onRefresh={() => undefined} />,
    )
    expect(html).toContain('id="dgs-skills-body" hidden=""')
    expect(html).toContain('共 12 个技能')
    expect(html).not.toContain('刷新')
  })

  it('shows the backup status for every skill', () => {
    const mixed: SkillListResponse = {
      skills: [
        { name: 'synced-skill', files: 1, bytes: 10, syncStatus: 'synced' },
        { name: 'local-skill', files: 1, bytes: 10, syncStatus: 'local-only' },
        { name: 'remote-skill', files: 1, bytes: 10, syncStatus: 'remote-only' },
        { name: 'modified-skill', files: 2, bytes: 20, syncStatus: 'modified' },
      ],
      warnings: [],
    }
    const html = renderToStaticMarkup(
      <SkillsSection t={t} skills={mixed} loading={false} error={null} onRefresh={() => undefined} />,
    )
    expect(html).toContain('已备份')
    expect(html).toContain('仅本机')
    expect(html).toContain('仅仓库')
    expect(html).toContain('有修改')
  })

  it('shows only the first ten skills on the default page', () => {
    const html = renderToStaticMarkup(
      <SkillsSection t={t} skills={skills} loading={false} error={null} onRefresh={() => undefined} />,
    )
    expect(html.match(/class="dgs-skillItem"/g)).toHaveLength(10)
    expect(html).toContain('skill-0')
    expect(html).not.toContain('skill-10')
    expect(html).toContain('显示 1–10，共 12 个')
    expect(html).toContain('第 1 / 2 页')
  })
})
