/** The standalone backup-contents card above the repository card. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScopeSection } from '../../client/src/ui/ScopeSection'
import { createTranslate, zh } from '../../client/src/i18n'

const t = createTranslate(key => zh[key] ?? key)

function render(scopes: { plugins: boolean; skills: boolean }, saving = false): string {
  return renderToStaticMarkup(
    <ScopeSection t={t} scopes={scopes} saving={saving} onChange={() => undefined} />,
  )
}

describe('backup contents card', () => {
  it('shows both scopes on by default with per-scope hints', () => {
    const html = render({ plugins: true, skills: true })
    expect(html).toContain('备份内容')
    expect(html).toContain('aria-label="插件"')
    expect(html).toContain('aria-label="技能"')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2)
    expect(html).toContain('API Key、Token、密码等内容不会上传')
    expect(html).toContain('可能含私有提示词或脚本')
  })

  it('disables the last enabled scope so at least one stays on', () => {
    const html = render({ plugins: true, skills: false })
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="插件" class="dgs-switch" disabled=""/)
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="技能" class="dgs-switch"><\/button>/)
  })

  it('disables both switches while saving', () => {
    const html = render({ plugins: true, skills: true }, true)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})
