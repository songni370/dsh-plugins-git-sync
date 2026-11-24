// @vitest-environment jsdom
/**
 * Per-plugin preference controls: every row exposes one 「仅本设备」 checkbox,
 * and a multi-selection can be switched between the public pool and this
 * device in a single request (no second dialog).
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
    sharedEnabled: true,
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

function render(
  rows: PluginListRow[],
  onResolveConflict?: (pluginId: string, choice: 'local' | 'remote') => Promise<void>,
): string {
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
      {...(onResolveConflict === undefined ? {} : { onResolveConflict })}
    />,
  )
}

describe('per-plugin preferences', () => {
  it('exposes one 仅本设备 checkbox per row instead of dropdowns', () => {
    const html = render([row()])
    expect(html).not.toContain('>设置<')
    expect(html).toContain('>仅本设备<')
    expect(html).not.toContain('安装范围')
    expect(html).not.toContain('启停')
    expect(html).toContain('aria-label="仅本设备：alpha"')
  })

  it('hides a repeated id line but keeps a distinct display name', () => {
    expect(render([row()])).not.toContain('dgs-pluginId')
    const distinct = render([row({ id: 'dsh-better-sidebar', name: 'Better Sidebar', displayName: 'Better Sidebar' })])
    expect(distinct).toContain('dgs-pluginId')
    expect(distinct).toContain('Better Sidebar')
  })

  it('checks the row checkbox when the plugin is private to this device', () => {
    const html = render([row({ scopeSelfOnly: true, scopeDevices: ['dev-a'] })])
    const checkbox = html.split('aria-label="仅本设备：alpha"')[0] ?? ''
    expect(checkbox).toContain('checked=""')
  })

  it('offers a per-row resolution dropdown for a conflicting plugin', () => {
    const conflicted = row({
      conflictInfo: {
        id: 'conflict:alpha',
        pluginId: 'alpha',
        pluginName: 'alpha',
        reason: 'local-deleted',
        fields: ['presence'],
        localVersion: null,
        remoteVersion: '1.0.0',
        localEnabled: null,
        remoteEnabled: true,
        hadBaseline: true,
      },
    })
    const html = render([conflicted], async () => undefined)
    expect(html).toContain('冲突处理')
    expect(html).toContain('aria-label="冲突处理: alpha"')
    expect(html).toContain('本机已卸载')
  })
})
