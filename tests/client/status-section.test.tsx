/** Sync status tiles follow the backup-content switches. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusSection } from '../../client/src/ui/StatusSection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { SkillListResponse } from '../../src/http/api-types'
import type { StatusView, SyncConfigView } from '../../src/types'

const t = createTranslate(key => zh[key] ?? key)

const skills: SkillListResponse = {
  skills: [{ name: 'ponytail', files: 1, bytes: 1024, syncStatus: 'synced', presence: 'both' }],
  warnings: [],
}

function statusView(scopes: { plugins: boolean; skills: boolean }): StatusView {
  const config: SyncConfigView = {
    repoUrl: 'https://github.com/example/backup.git',
    branch: 'main',
    backupDir: '',
    authMode: 'credential-helper',
    tokenEnvVar: '',
    username: '',
    profiles: ['desktop'],
    includeConfigs: false,
    backupScopes: scopes,
    includeLocalPlugins: false,
    excludedPlugins: [],
    excludedSkills: [],
    excludedConfigPlugins: [],
    autoSync: {
      enabled: false,
      mode: 'two-way',
      intervalMinutes: 0,
      startupDelayMs: 15_000,
      onStartup: false,
      onPluginChange: false,
      debounceMs: 10_000,
    },
    deviceName: 'mac',
    tokenAvailable: false,
    device: { id: 'device-1', name: 'mac', platform: 'darwin', arch: 'arm64', dshVersion: '0.2.1-rc.3', pluginVersion: '0.2.10' },
    activeProfile: 'desktop',
    availableProfiles: ['desktop'],
    dataDir: '~/.dsh/dsh-plugins-git-sync',
  }
  return {
    state: 'synced',
    config,
    branch: 'main',
    lastSyncAt: null,
    lastCommit: null,
    lastOperation: null,
    localPluginCount: 8,
    remotePluginCount: 7,
    pendingUploads: 0,
    pendingDownloads: 0,
    conflictCount: 0,
    lastError: null,
    busy: false,
    connection: null,
  }
}

function render(scopes: { plugins: boolean; skills: boolean }): string {
  return renderToStaticMarkup(
    <StatusSection t={t} status={statusView(scopes)} skills={skills} embedded />,
  )
}

function statusWithDevices(): StatusView {
  const view = statusView({ plugins: true, skills: true })
  view.remoteDeviceCount = 2
  view.devices = [
    {
      id: 'dev-a',
      name: 'Mac A',
      platform: 'darwin',
      arch: 'arm64',
      dshVersion: '0.2.2-rc.5',
      pluginVersion: '0.3.0',
      lastSyncAt: '2026-11-20T08:00:00.000Z',
      lastResult: 'ok',
      updatedAt: '2026-11-20T08:00:00.000Z',
    },
    {
      id: 'dev-b',
      name: 'Mac B',
      platform: 'win32',
      arch: 'x64',
      dshVersion: '0.2.2-rc.1',
      pluginVersion: '0.3.0',
      lastSyncAt: null,
      lastResult: 'ok',
      updatedAt: '2026-11-19T08:00:00.000Z',
    },
  ]
  view.connection = {
    ok: true,
    at: '2026-11-20T09:00:00.000Z',
    branch: 'main',
    head: 'abc1234',
    message: '仓库连接正常',
    authMethod: 'ssh',
  }
  return view
}

describe('device list', () => {
  it('shows a never-synced device without a contradictory success label', () => {
    const html = renderToStaticMarkup(<StatusSection t={t} status={statusWithDevices()} skills={skills} embedded />)
    expect(html).toContain('Mac A')
    expect(html).toContain('Mac B')
    expect(html).toContain('从未同步')
    expect(html).not.toContain('成功 · 从未')
    expect(html).toContain('检查于')
  })
})

describe('sync status tiles', () => {
  it('shows plugin and skill tiles when both scopes are enabled', () => {
    const html = render({ plugins: true, skills: true })
    expect(html).toContain('本机插件')
    expect(html).toContain('本机技能')
    expect(html).toContain('仓库技能')
  })

  it('hides plugin tiles when plugin backup is off', () => {
    const html = render({ plugins: false, skills: true })
    expect(html).not.toContain('本机插件')
    expect(html).toContain('本机技能')
  })

  it('hides skill tiles when skill backup is off', () => {
    const html = render({ plugins: true, skills: false })
    expect(html).toContain('本机插件')
    expect(html).not.toContain('本机技能')
  })
})
