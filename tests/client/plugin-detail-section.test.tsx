// @vitest-environment jsdom
/**
 * The plugin's own detail page carries the compact backup settings card:
 * scope, and the switch that registers the optional Backup tab.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { PluginDetailSection } from '../../client/src/ui/PluginDetailSection'
import { createTranslate, zh } from '../../client/src/i18n'
import {
  resetPluginsTabVisibility,
  setPluginsTabEnabled,
} from '../../client/src/plugins-tab-visibility'

const t = createTranslate(key => zh[key] ?? key)

const subject = {
  kind: 'bundle',
  pkg: { name: 'dsh-plugins-git-sync' },
}

beforeEach(() => {
  resetPluginsTabVisibility()
})

describe('PluginDetailSection', () => {
  it('renders only on this plugin’s bundle page', () => {
    expect(renderToStaticMarkup(<PluginDetailSection t={t} subject={{ kind: 'bundle', pkg: { name: 'other' } }} />)).toBe('')
    expect(renderToStaticMarkup(<PluginDetailSection t={t} subject={{ kind: 'item', id: 'other' }} />)).toBe('')
  })

  it('shows the backup scope and the tab switch', () => {
    const html = renderToStaticMarkup(<PluginDetailSection t={t} subject={subject} />)
    expect(html).toContain('备份设置')
    expect(html).toContain('插件 + 技能')
    expect(html).toContain('插件清单与已部署技能')
    expect(html).toContain('在「插件」页面显示「备份」标签页')
    expect(html).toContain('aria-checked="true"')
  })

  it('follows the persisted switch state', () => {
    setPluginsTabEnabled(false)
    const html = renderToStaticMarkup(<PluginDetailSection t={t} subject={subject} />)
    expect(html).toContain('aria-checked="false"')
  })
})
