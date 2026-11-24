// @vitest-environment jsdom
/**
 * Per-plugin preference controls: each row shows a compact version pair and two
 * destination checkboxes (公共 / 本设备). Edits stay pending until the single
 * save button is pressed; there is no multi-selection and no second dialog.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PluginsSection } from '../../client/src/ui/PluginsSection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { PluginListRow } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

// The interaction tests below mount the component with real event dispatch.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  it('shows version columns, destination checkboxes and one save button', () => {
    const html = render([row()])
    expect(html).not.toContain('>设置<')
    expect(html).not.toContain('安装范围')
    expect(html).not.toContain('启停')
    expect(html).toContain('>本机版本<')
    expect(html).toContain('>仓库版本<')
    expect(html).toContain('>操作<')
    expect(html).toContain('aria-label="公共: alpha"')
    expect(html).toContain('aria-label="本设备: alpha"')
    expect(html).toContain('保存更改（0）')
    expect(html).toContain('勾选后点击保存')
    expect(html).not.toContain('>选择插件')
    expect(html).not.toContain('dgs-bulkBar')
    expect(html).not.toContain('aria-haspopup="menu"')
  })

  it('hides a repeated id line but keeps a distinct display name', () => {
    expect(render([row()])).not.toContain('dgs-pluginId')
    const distinct = render([row({ id: 'dsh-better-sidebar', name: 'Better Sidebar', displayName: 'Better Sidebar' })])
    expect(distinct).toContain('dgs-pluginId')
    expect(distinct).toContain('Better Sidebar')
  })

  it('checks 本设备 when the plugin is private to this device', () => {
    const html = render([row({ scopeSelfOnly: true, scopeDevices: ['dev-a'] })])
    expect(html).toMatch(/checked=""[^>]*aria-label="本设备: alpha"|aria-label="本设备: alpha"[^>]*checked=""/)
    const shared = render([row()])
    expect(shared).toMatch(/checked=""[^>]*aria-label="公共: alpha"|aria-label="公共: alpha"[^>]*checked=""/)
  })

  it('moves the conflict resolution into the status cell', () => {
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
    expect(html).toContain('>处理<')
    expect(html).toContain('aria-label="处理: alpha"')
    expect(html).not.toContain('aria-label="操作: alpha"')
    expect(html).toContain('本机已卸载')
  })
})

describe('pending preference edits', () => {
  it('keeps edits local until the save button is pressed', async () => {
    const onApplyPreferences = vi.fn(async () => undefined)
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginsSection
          t={t}
          plugins={{ rows: [row()], activeProfile: 'desktop', availableProfiles: ['desktop'] }}
          loading={false}
          error={null}
          filter=""
          exclusions={new Set()}
          busy={false}
          onFilterChange={() => undefined}
          onToggle={() => undefined}
          onRefresh={() => undefined}
          onApplyPreferences={onApplyPreferences}
        />,
      )
    })
    const privateBox = container.querySelector('input[aria-label="本设备: alpha"]') as HTMLInputElement | null
    const publicBox = container.querySelector('input[aria-label="公共: alpha"]') as HTMLInputElement | null
    expect(privateBox).not.toBeNull()
    expect(publicBox?.checked).toBe(true)

    await act(async () => {
      privateBox?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(onApplyPreferences).not.toHaveBeenCalled()
    expect(privateBox?.checked).toBe(true)
    const save = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('保存更改'))
    expect(save?.textContent).toContain('保存更改（1）')
    expect(save?.disabled).toBe(false)

    await act(async () => {
      save?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onApplyPreferences).toHaveBeenCalledTimes(1)
    expect(onApplyPreferences).toHaveBeenCalledWith([{ pluginId: 'alpha', scope: 'self' }])

    await act(async () => {
      root.unmount()
    })
  })

  it('drops a pending edit when the user switches back', async () => {
    const onApplyPreferences = vi.fn(async () => undefined)
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginsSection
          t={t}
          plugins={{ rows: [row()], activeProfile: 'desktop', availableProfiles: ['desktop'] }}
          loading={false}
          error={null}
          filter=""
          exclusions={new Set()}
          busy={false}
          onFilterChange={() => undefined}
          onToggle={() => undefined}
          onRefresh={() => undefined}
          onApplyPreferences={onApplyPreferences}
        />,
      )
    })
    const privateBox = container.querySelector('input[aria-label="本设备: alpha"]')
    const publicBox = container.querySelector('input[aria-label="公共: alpha"]')
    await act(async () => {
      privateBox?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      publicBox?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('保存更改'))
    expect(save?.textContent).toContain('保存更改（0）')
    expect(onApplyPreferences).not.toHaveBeenCalled()
    await act(async () => {
      root.unmount()
    })
  })
})
