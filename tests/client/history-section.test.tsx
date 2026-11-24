/** History card keeps only the latest ten commits and starts collapsed. */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HistorySection } from '../../client/src/ui/HistorySection'
import { createTranslate, zh } from '../../client/src/i18n'
import type { HistoryResponse } from '../../src/http/api-types'

const t = createTranslate(key => zh[key] ?? key)

const history: HistoryResponse = {
  entries: Array.from({ length: 12 }, (_, index) => ({
    commit: `${String(index).padStart(8, '0')}abcdef1234567890abcdef12345678`,
    shortCommit: `${index}`.padStart(7, '0'),
    date: '2026-10-28T07:13:55.045Z',
    author: 'DSH',
    subject: `commit ${index}`,
    operation: 'backup',
    deviceName: 'mac',
    result: 'ok',
    pluginCount: 5,
  })),
  lastOperation: null,
}

describe('history card', () => {
  it('renders only the latest ten commits', () => {
    const html = renderToStaticMarkup(
      <HistorySection
        t={t}
        history={history}
        loading={false}
        error={null}
        busy={false}
        onRestoreCommit={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    expect(html.match(/class="dgs-historyItem"/g)).toHaveLength(10)
    expect(html).toContain('commit 0')
    expect(html).not.toContain('commit 10')
  })


  it('humanizes plugin commits and leaves external commits alone', () => {
    const entries: HistoryResponse = {
      entries: [
        {
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          shortCommit: 'aaaaaaaa',
          date: '2026-11-24T08:13:00.000Z',
          author: 'DSH',
          subject: '[dsh-plugins-git-sync] preferences desktop: alpha 所有设备 / all devices',
          operation: 'preferences',
          deviceName: 'mac',
          result: 'migrated',
          pluginCount: 9,
        },
        {
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          shortCommit: 'bbbbbbbb',
          date: '2026-11-20T09:36:00.000Z',
          author: 'DSH',
          subject: 'chore: remove QA web profile data',
          operation: 'unknown',
        },
      ],
      lastOperation: null,
    }
    const html = renderToStaticMarkup(
      <HistorySection
        t={t}
        history={entries}
        loading={false}
        error={null}
        busy={false}
        onRestoreCommit={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    expect(html).toContain('插件设置')
    expect(html).toContain('已迁移')
    expect(html).toContain('alpha 公共')
    expect(html).toContain('其他提交')
    expect(html).toContain('chore: remove QA web profile data')
    expect(html).not.toContain('未知')
  })

  it('starts collapsed', () => {
    const html = renderToStaticMarkup(
      <HistorySection
        t={t}
        history={history}
        loading={false}
        error={null}
        busy={false}
        onRestoreCommit={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    expect(html).toContain('id="dgs-history-body" hidden=""')
    expect(html).not.toContain('刷新')
  })
})
