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
