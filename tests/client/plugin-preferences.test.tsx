// @vitest-environment jsdom
/**
 * Per-plugin preference controls: each row can open the settings dialog, and
 * rows with a device-local choice show a badge instead of silently differing.
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
      onSavePreferences={async () => undefined}
    />,
  )
}

describe('per-plugin preferences', () => {
  it('offers a settings action for every row', () => {
    expect(render([row()])).toContain('设置')
  })

  it('marks a device-local availability choice', () => {
    const html = render([row({ scopeSelfOnly: true, enabledOverride: false, scopeDevices: ['dev-a'] })])
    expect(html).toContain('仅本机')
    expect(html).toContain('本机停用')
  })
})
