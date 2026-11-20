// @vitest-environment jsdom
/**
 * Per-plugin preference controls: every row exposes inline availability and
 * enabled-override dropdowns (no second dialog) whose triggers show the
 * current device-local choice.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PluginsSection } from '../../client/src/ui/PluginsSection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { PluginListRow } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

function row(patch: Partial<PluginListRow> = {}): PluginListRow {
  return {
    id: 'alpha',
    name: 'alpha',
    presence: 'both',
    version: '1.0.0',
    remoteVersion: '1.0.0',
    enabled: false,
    remoteEnabled: true,
    syncStatus: 'synced',
    inSync: false,
    syncable: true,
    selected: true,
    local: {
      id: 'alpha',
      name: 'alpha',
      displayName: 'alpha',
      version: '1.0.0',
      origin: 'npm',
      installSpec: 'alpha@1.0.0',
      enabled: false,
      builtIn: false,
      syncable: true,
      pathOnly: false,
      profile: 'desktop',
      platform: 'darwin',
      rows: [],
      configs: {},
      configSkipped: [],
    },
    ...patch,
  }
}

function render(rows: PluginListRow[]): string {
  return renderToStaticMarkup(
    <PluginsSection
      t={t}
      plugins={{ rows, activeProfile: 'desktop', availableProfiles: ['desktop'] }}
      loading={false}
      error={null}
      filter=""
      exclusions={new Set()}
      busy={false}
      onFilterChange={() => undefined}
      onToggle={() => undefined}
      onRefresh={() => undefined}
      onApplyPreferences={async () => undefined}
    />,
  )
}

describe('per-plugin preferences', () => {
  it('offers inline dropdown actions for every row without a dialog', () => {
    const html = render([row()])
    expect(html).not.toContain('>设置<')
    expect(html).toContain('本机偏好')
    // Closed menus: the triggers show the current choice, menus stay hidden.
    expect(html.match(/aria-haspopup="menu"/g)?.length).toBe(2)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('所有设备')
    expect(html).toContain('跟随')
    expect(html).not.toContain('role="menu"')
  })

  it('hides a repeated id line but keeps a distinct display name', () => {
    expect(render([row()])).not.toContain('dgs-pluginId')
    const distinct = render([row({ id: 'dsh-better-sidebar', name: 'Better Sidebar', displayName: 'Better Sidebar' })])
    expect(distinct).toContain('dgs-pluginId')
    expect(distinct).toContain('Better Sidebar')
  })

  it('shows the device-local choices on the triggers', () => {
    const html = render([row({ scopeSelfOnly: true, enabledOverride: false, scopeDevices: ['dev-a'] })])
    expect((html.split('aria-label="使用范围: alpha"')[1] ?? '').slice(0, 260)).toContain('仅本机')
    expect((html.split('aria-label="启停范围: alpha"')[1] ?? '').slice(0, 260)).toContain('本机停用')
  })
})
