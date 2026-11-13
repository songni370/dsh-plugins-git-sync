// @vitest-environment jsdom
/**
 * Render smoke test for the settings page.
 *
 * Verifies the client half actually mounts, performs its initial Host calls,
 * renders the four main sections with localized text, and opens the
 * confirmation protocol when the Host refuses a destructive operation. This is
 * the closest check available without an authenticated Harness page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Page } from '../../client/src/ui/Page'
import { resetPluginsTabVisibility } from '../../client/src/plugins-tab-visibility'
import { createTranslate, en, zh } from '../../client/src/i18n'
import type { HistoryResponse, PluginListResponse, SkillListResponse, StatusPayload } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

/** Per-test repository URL override (null = the configured default mock). */
let repoUrlOverride: string | null = null

/** Per-test "fresh process" flag: the remote side is not prepared yet. */
let remoteUnknown = false

/** The stubbed Host fetch; asserted by the freshness and feedback tests. */
let fetchMock: ReturnType<typeof vi.fn>

/** Build the status payload the Host returns. */
function statusPayload(): StatusPayload {
  return {
    status: {
      state: 'ahead',
      config: {
        repoUrl: repoUrlOverride ?? 'https://github.com/example/backup.git',
        branch: 'main',
        backupDir: '',
        authMode: 'credential-helper',
        tokenEnvVar: '',
        username: '',
        profiles: ['desktop'],
        includeConfigs: true,
        backupScopes: { plugins: true, skills: true },
        includeLocalPlugins: false,
        excludedPlugins: [],
        excludedSkills: [],
        excludedConfigPlugins: [],
        autoSync: { enabled: false, mode: 'two-way', intervalMinutes: 30, startupDelayMs: 15_000, onStartup: false, onPluginChange: false, debounceMs: 10_000 },
        deviceName: 'mac',
            tokenAvailable: false,
        device: { id: 'device-1', name: 'mac', platform: 'darwin', arch: 'arm64', dshVersion: '0.2.1-rc.3', pluginVersion: '0.1.0' },
        activeProfile: 'desktop',
        availableProfiles: ['desktop', 'web'],
        dataDir: '~/.dsh/dsh-plugins-git-sync',
      },
      branch: 'main',
      lastSyncAt: null,
      lastCommit: null,
      lastOperation: null,
      localPluginCount: 5,
      remotePluginCount: remoteUnknown ? null : 5,
      pendingUploads: 1,
      pendingDownloads: 0,
      conflictCount: 0,
      lastError: null,
      busy: false,
      connection: null,
    },
    logs: [],
  }
}

/** Build the plugin list payload. */
function pluginsPayload(): PluginListResponse {
  return {
    rows: [{
      id: 'dsh-context',
      name: 'dsh-context',
      presence: 'both',
      version: '0.77.0',
      remoteVersion: '0.77.0',
      enabled: true,
      remoteEnabled: true,
      syncStatus: 'synced',
      inSync: true,
      syncable: true,
      selected: true,
    }],
    activeProfile: 'desktop',
    availableProfiles: ['desktop', 'web'],
  }
}

/** Build the deployed-skill payload. */
function skillsPayload(): SkillListResponse {
  return {
    skills: [{ name: 'ponytail', files: 1, bytes: 1234, syncStatus: 'synced' }],
    warnings: [],
  }
}

/** Build the history payload. */
function historyPayload(): HistoryResponse {
  return {
    entries: [{
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      shortCommit: 'abcdef1',
      date: '2026-10-28T07:13:55.045Z',
      author: 'DSH',
      subject: '[dsh-plugins-git-sync] backup desktop',
      operation: 'backup',
      deviceName: 'mac',
      result: 'ok',
      pluginCount: 5,
    }],
    lastOperation: null,
  }
}

/** Fake the four initial Host calls; `/backup` refuses and demands confirmation. */
function installFetchMock(): void {
  fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const target = String(url)
    const envelope = (value: unknown): unknown => ({ ok: true, value })
    const failure = (code: string, message: string, details?: unknown): unknown => ({ ok: false, error: { code, message, details } })
    let payload: unknown
    if (target.endsWith('/status')) payload = envelope(statusPayload())
    else if (target.endsWith('/plugins/list')) payload = envelope(pluginsPayload())
    else if (target.endsWith('/skills/list')) payload = envelope(skillsPayload())
    else if (target.endsWith('/history')) payload = envelope(historyPayload())
    else if (target.endsWith('/backup')) {
      payload = failure('confirmation-required', '需要确认 / confirmation required', {
        plan: {
          direction: 'push',
          profile: 'desktop',
          generatedAt: '2026-10-28T07:13:55.045Z',
          actions: [{
            kind: 'remove-remote',
            pluginId: 'dsh-context',
            pluginName: 'dsh-context',
            detail: '从远端备份中标记删除 / mark deleted in repository',
            destructive: true,
          }],
          conflicts: [],
          diffs: [],
          requiresConfirmation: true,
          warnings: [],
          localPluginCount: 5,
          remotePluginCount: 5,
        },
      })
    } else if (target.endsWith('/sync/preview')) {
      payload = envelope({
        direction: 'two-way',
        plan: {
          direction: 'two-way',
          profile: 'desktop',
          generatedAt: '2026-10-28T07:13:55.045Z',
          actions: [],
          conflicts: [],
          diffs: [],
          requiresConfirmation: false,
          warnings: [],
          localPluginCount: 5,
          remotePluginCount: 5,
        },
      })
    } else if (target.endsWith('/sync')) {
      payload = envelope({
        ok: true,
        operation: 'sync',
        startedAt: '2026-10-28T07:13:55.045Z',
        finishedAt: '2026-10-28T07:13:55.045Z',
        noChanges: true,
        commit: null,
        pushed: false,
        actionOutcomes: [],
        warnings: [],
      })
    } else if (target.endsWith('/diff')) {
      payload = envelope({ direction: 'two-way', plan: { direction: 'two-way', profile: 'desktop', generatedAt: '', actions: [], conflicts: [], diffs: [], requiresConfirmation: false, warnings: [], localPluginCount: 5, remotePluginCount: 5 } })
    } else if (target.endsWith('/config/save')) payload = envelope({ config: statusPayload().status.config })
    else payload = envelope({})
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
    } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  resetPluginsTabVisibility()
  repoUrlOverride = null
  remoteUnknown = false
  installFetchMock()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Page t={t} />)
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  repoUrlOverride = null
  remoteUnknown = false
  vi.unstubAllGlobals()
})

/** Wait until the initial fetches settled and the page left its loading state. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** POST bodies sent to `/status`, in call order. */
function statusBodies(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/status'))
    .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
}

describe('settings page render', () => {
  it('registers the settings menu label as 插件备份 / Plugin Backup', () => {
    expect(zh.nav).toBe('插件备份')
    expect(en.nav).toBe('Plugin Backup')
    expect(createTranslate(key => (key === 'nav' ? 'Plugin Backup' : key))('nav')).toBe('Plugin Backup')
    // Plugins-page tab and the settings-page shortcut label.
    expect(zh.tab).toBe('备份')
    expect(en.tab).toBe('Backup')
    expect(zh.detailTitle).toBe('备份设置')
    expect(zh.tabVisibilityLabel).toContain('备份')
  })

  it('mounts and renders the repository configuration', async () => {
    await settle()
    expect(container.textContent).toContain('仓库配置')
    expect(container.textContent).toContain('同步状态')
  })

  it('shows skill tiles in the sync status area', async () => {
    await settle()
    expect(container.textContent).toContain('本地技能')
    expect(container.textContent).toContain('仓库技能')
    expect(container.textContent).toContain('已排除')
  })

  it('collapses an already configured repository card and expands it on demand', async () => {
    await settle()
    expect(container.textContent).toContain('已配置')
    const repoInput = () => container.querySelector('#dgs-config-repo')
    expect(repoInput()?.closest('[hidden]')).not.toBeNull()
    // Collapsed shows only the title, the status badge and the toggle button.
    expect(container.querySelector('.dgs-configSummary')).toBeNull()
    expect(container.textContent).not.toContain('Git 仓库地址与认证方式')
    const edit = Array.from(container.querySelectorAll('button')).find(button => (button.textContent ?? '').trim() === '编辑配置')
    expect(edit).toBeDefined()
    await act(async () => {
      edit?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(repoInput()?.closest('[hidden]')).toBeNull()
    const collapse = Array.from(container.querySelectorAll('button')).find(button => (button.textContent ?? '').trim() === '收起')
    expect(collapse).toBeDefined()
  })

  it('starts expanded on a fresh install with no repository configured', async () => {
    repoUrlOverride = ''
    await act(async () => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Page t={t} />)
    })
    await settle()
    expect(container.textContent).toContain('未配置仓库')
    expect(container.querySelector('#dgs-config-repo')?.closest('[hidden]')).toBeNull()
  })

  it('shows all four manual actions directly without a more-actions menu', async () => {
    await settle()
    const main = container.querySelector('.dgs-actionsMain')
    expect(main).not.toBeNull()
    const buttons = Array.from(main?.querySelectorAll(':scope > button') ?? []).map(
      button => button.textContent ?? '',
    )
    expect(buttons).toHaveLength(4)
    expect(buttons[0]).toContain('同步')
    expect(buttons[1]).toContain('检查差异')
    expect(buttons[2]).toContain('备份到 Git')
    expect(buttons[3]).toContain('从 Git 恢复')
    expect(container.querySelector('.dgs-moreActions')).toBeNull()
    // The direction selector is gone; diff always previews a two-way sync.
    expect(container.querySelector('#dgs-diff-direction')).toBeNull()
  })
  it('opens the diff preview in a modal instead of below the actions', async () => {
    await settle()
    const diffButton = Array.from(container.querySelectorAll('button')).find(button =>
      (button.textContent ?? '').includes('检查差异'),
    )
    expect(diffButton).toBeDefined()
    await act(async () => {
      diffButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const modal = container.querySelector('.dgs-modal')
    expect(modal).not.toBeNull()
    expect(modal?.textContent).toContain('差异预览')
    expect(modal?.textContent).not.toContain('仅预览')
    expect(modal?.textContent).toContain('当前没有需要同步的改动')
    expect(container.querySelector('.dgs-diffPanel')).toBeNull()
    expect(modal?.closest('.dgs-card')).toBeNull()
  })

  it('merges auto-sync into the operations card as a collapsed panel', async () => {
    await settle()
    const panel = container.querySelector('.dgs-autoSection')
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('.dgs-autoHeader')).not.toBeNull()
    expect(panel?.textContent).toContain('自动同步')
    expect(panel?.textContent).toContain('未开启')
    // The schedule form starts collapsed; only the status line is visible.
    const body = panel?.querySelector('#dgs-auto-body')
    expect(body?.hasAttribute('hidden')).toBe(true)
    expect(panel?.querySelectorAll('.dgs-segmented button')).toHaveLength(3)
    expect(panel?.querySelectorAll('[role="switch"]')).toHaveLength(1)
    expect(panel?.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    // Auto-sync is event-driven: the interval input is gone for good.
    expect(panel?.querySelector('#dgs-auto-interval')).toBeNull()
    // The startup trigger has a configurable delay (seconds), 15s by default.
    const delay = panel?.querySelector('#dgs-auto-startup-delay') as HTMLInputElement | null
    expect(delay?.value).toBe('15')

    const toggle = panel?.querySelector('button[aria-controls="dgs-auto-body"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    expect(panel?.querySelector('#dgs-auto-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('starts history collapsed and expands it on demand', async () => {
    await settle()
    const body = container.querySelector('#dgs-history-body')
    expect(body?.hasAttribute('hidden')).toBe(true)
    const toggle = container.querySelector('button[aria-controls="dgs-history-body"]') as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle?.click()
    })
    expect(body?.hasAttribute('hidden')).toBe(false)
    const items = container.querySelectorAll('.dgs-historyItem')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('abcdef1')
    expect(items[0]?.textContent).toContain('备份')
    expect(items[0]?.querySelector('.dgs-historyDotOk')).not.toBeNull()
    expect(container.querySelector('.dgs-historyList')).not.toBeNull()
  })

  it('lists deployed skills below the plugin list', async () => {
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain('技能')
    expect(text).toContain('共 1 个技能')
    const item = container.querySelector('.dgs-skillItem')
    expect(item?.textContent).toContain('ponytail')
    expect(item?.textContent).toContain('1 个文件')
  })

  it('renders the status tile row and metadata grid', async () => {
    await settle()
    const text = container.textContent ?? ''
    for (const label of ['本地插件', '仓库插件', '待上传', '待下载', '冲突', '设备', '分支', '上次同步']) {
      expect(text).toContain(label)
    }
    expect(container.querySelector('.dgs-statusTiles')).not.toBeNull()
    expect(container.querySelectorAll('.dgs-statusTile')).toHaveLength(10)
    expect(container.querySelectorAll('.dgs-statusMetaItem')).toHaveLength(6)
    // The status block now lives inside the operations card, below the actions.
    const actionsCard = container.querySelector('.dgs-actionsMain')?.closest('.dgs-card')
    expect(actionsCard?.querySelector('.dgs-syncStatusBlock')).not.toBeNull()
  })

  it('renders live status counts and the plugin list', async () => {
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain('通过 Git 仓库备份、恢复并跨设备同步 DSH 插件与技能。')
    expect(text).toContain('dsh-context')
    expect(text).toContain('有待上传变更')
  })

  it('primes the repository before loading the lists when the remote side is unknown', async () => {
    remoteUnknown = true
    const firstCall = fetchMock.mock.calls.length
    await act(async () => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Page t={t} />)
    })
    await settle()
    const calls = fetchMock.mock.calls.slice(firstCall)
    const refreshIndex = calls.findIndex(
      ([url, init]) => String(url).endsWith('/status')
        && String((init as RequestInit | undefined)?.body ?? '').includes('"refresh":true'),
    )
    const listIndex = calls.findIndex(([url]) => String(url).endsWith('/plugins/list'))
    expect(refreshIndex).toBeGreaterThanOrEqual(0)
    // The lists must be loaded after the prime, not before it: otherwise they
    // would still compare against the unknown repository.
    expect(listIndex).toBeGreaterThan(refreshIndex)
  })

  it('does not refetch the repository when the remote side is already known', async () => {
    await settle()
    expect(statusBodies().every(body => !body.includes('"refresh":true'))).toBe(true)
  })

  it('opens a prefilled GitHub issue from the intro row', async () => {
    await settle()
    expect(container.querySelector('.dgs-introRow .dgs-intro')).not.toBeNull()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const button = Array.from(container.querySelectorAll('button')).find(
      candidate => (candidate.textContent ?? '').trim() === '问题反馈',
    )
    expect(button).toBeDefined()
    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(open).toHaveBeenCalledTimes(1)
    const url = String(open.mock.calls[0]?.[0] ?? '')
    expect(url.startsWith('https://github.com/songni370/dsh-plugins-git-sync/issues/new?')).toBe(true)
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('插件版本: 0.1.0')
    expect(decoded).toContain('DSH 版本: 0.2.1-rc.3')
    expect(decoded).toContain('系统: darwin arm64')
    open.mockRestore()
  })

  it('starts the plugin list collapsed and expands on demand', async () => {
    await settle()
    const body = container.querySelector('#dgs-plugins-body')
    expect(body).not.toBeNull()
    expect(body?.hasAttribute('hidden')).toBe(true)
    // The stylesheet must actually hide it (author display:flex would
    // otherwise override the browser's default [hidden] rule).
    expect(body === null ? '' : window.getComputedStyle(body).display).toBe('none')
    // The refresh button now sits next to the filter inside the hidden body.
    const refresh = Array.from(container.querySelectorAll('button')).find(button =>
      (button.textContent ?? '').includes('刷新列表'),
    )
    expect(refresh).toBeDefined()
    expect(body?.contains(refresh ?? null)).toBe(true)
    const filter = container.querySelector('#dgs-plugins-filter')
    expect(filter).not.toBeNull()
    expect(body?.contains(filter)).toBe(true)
    const toggle = container.querySelector('button[aria-controls="dgs-plugins-body"]') as HTMLButtonElement
    expect(toggle.textContent).toContain('展开列表')
    await act(async () => {
      toggle.click()
    })
    const opened = container.querySelector('#dgs-plugins-body')
    expect(opened?.hasAttribute('hidden')).toBe(false)
    // The filter and refresh share the same row when expanded.
    expect(opened?.querySelector('.dgs-pluginsFilterRow #dgs-plugins-filter')).not.toBeNull()
    expect(opened?.querySelector('.dgs-pluginsFilterRow')?.textContent).toContain('刷新列表')
  })

  it('syncs directly when the plan needs no decision', async () => {
    await settle()
    const main = container.querySelector('.dgs-actionsMain')
    const sync = main?.querySelector('button')
    expect(sync?.textContent).toContain('同步')
    await act(async () => {
      sync?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain('同步完成')
  })

  it('opens the confirmation dialog with the destructive plan from the Host', async () => {
    await settle()
    const buttons = Array.from(container.querySelectorAll('button'))
    const backup = buttons.find(button => (button.textContent ?? '').includes('备份到 Git'))
    expect(backup).toBeDefined()
    await act(async () => {
      backup?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const text = container.textContent ?? ''
    expect(text).toContain('确认')
    expect(text).toContain('dsh-context')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
