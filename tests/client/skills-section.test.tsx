/** Skill card starts expanded and paginates its rows. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillsSection } from '../../client/src/ui/SkillsSection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { SkillListResponse } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

const baseProps = {
  t,
  loading: false,
  error: null,
  exclusions: new Set<string>(),
  busy: false,
  onToggle: () => undefined,
  onRefresh: () => undefined,
}

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
  it('starts expanded so the header and rows are visible', () => {
    const html = renderToStaticMarkup(
      <SkillsSection {...baseProps} skills={skills} />,
    )
    expect(html).toContain('id="dgs-skills-body"')
    expect(html).not.toContain('id="dgs-skills-body" hidden=""')
    expect(html).toContain('共 12 个技能')
    expect(html).not.toContain('刷新')
  })

  it('shows a column header row like the plugin list', () => {
    const html = renderToStaticMarkup(<SkillsSection {...baseProps} skills={skills} />)
    expect(html).toContain('>同步<')
    expect(html).toContain('>技能<')
    expect(html).toContain('>文件 / 大小<')
    expect(html).toContain('>状态<')
  })

  it('shows the backup status for every skill', () => {
    const mixed: SkillListResponse = {
      skills: [
        { name: 'synced-skill', files: 1, bytes: 10, syncStatus: 'synced' },
        { name: 'local-skill', files: 1, bytes: 10, syncStatus: 'local-only' },
        { name: 'remote-skill', files: 1, bytes: 10, syncStatus: 'remote-only' },
        { name: 'modified-skill', files: 2, bytes: 20, syncStatus: 'modified' },
        { name: 'excluded-skill', files: 1, bytes: 10, syncStatus: 'excluded' },
      ],
      warnings: [],
    }
    const html = renderToStaticMarkup(
      <SkillsSection {...baseProps} skills={mixed} />,
    )
    expect(html).toContain('已备份')
    expect(html).toContain('仅本机')
    expect(html).toContain('仅仓库')
    expect(html).toContain('有修改')
    expect(html).toContain('已排除')
  })

  it('renders the leftmost sync checkbox and honors exclusions', () => {
    const html = renderToStaticMarkup(
      <SkillsSection {...baseProps} skills={skills} exclusions={new Set(['skill-1'])} />,
    )
    expect(html.match(/type="checkbox"/g)).toHaveLength(10)
    expect(html).toContain('aria-label="同步: skill-0"')
    expect(html).toContain('aria-label="同步: skill-1"')
    expect(html).not.toContain('aria-label="同步: skill-10"')
  })

  it('shows only the first ten skills on the default page', () => {
    const html = renderToStaticMarkup(
      <SkillsSection {...baseProps} skills={skills} />,
    )
    expect(html.match(/class="dgs-skillItem"/g)).toHaveLength(10)
    expect(html).toContain('skill-0')
    expect(html).not.toContain('skill-10')
    expect(html).toContain('显示 1–10，共 12 个')
    expect(html).toContain('第 1 / 2 页')
  })
})
