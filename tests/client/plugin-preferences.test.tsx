// @vitest-environment jsdom
/**
 * Per-plugin preference controls: every row exposes inline availability and
 * enabled-override actions (no second dialog), and device-local choices are
 * marked with a badge.
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
  it('offers inline actions for every row without a dialog', () => {
    const html = render([row()])
    expect(html).not.toContain('>设置<')
    expect(html).toContain('所有设备')
    expect(html).toContain('仅本机')
    expect(html).toContain('跟随')
    expect(html).toContain('本机启用')
    expect(html).toContain('本机停用')
    expect(html).toContain('本机偏好')
  })

  it('marks a device-local availability choice and reflects it in the buttons', () => {
    const html = render([row({ scopeSelfOnly: true, enabledOverride: false, scopeDevices: ['dev-a'] })])
    expect(html).toContain('仅本机')
    expect(html).toContain('本机停用')
    // Both the scope and the enabled state report their active button.
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(2)
  })
})
