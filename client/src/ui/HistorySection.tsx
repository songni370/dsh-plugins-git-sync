/**
 * "History" card: the backup repository's commits and the one-click restore
 * of the local side to any of them.
 *
 * Rendered as a compact activity list instead of a seven-column table: each
 * entry states the operation and result on the first line, the subject and
 * commit on the second, and the time/device/plugin count as small metadata.
 * That keeps the useful information readable at a glance even for long
 * subjects and device names.
 *
 * A row's restore goes through the same confirmation path as "restore from
 * Git" (the page previews the commit with `/restore/preview`, then runs
 * `/rollback`), so a destructive history restore is never a single click.
 * @module ui/HistorySection
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { HistoryResponse } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import { formatDateTime, isGoodResult, operationLabel, resultLabel, shortCommit } from '../format'
import { Badge, Banner, Button, Card, LinkButton, Loading } from './controls'

/** Props for {@link HistorySection}. */
export interface HistorySectionProps {
  t: Translate
  history: HistoryResponse | null
  loading: boolean
  error: string | null
  /** Any operation that changes history is in flight. */
  busy: boolean
  onRestoreCommit: (commit: string) => void
  onRefresh: () => void
  /** Result of a rollback, shown inside this card. */
}

/** Render the history card. */
export function HistorySection(props: HistorySectionProps): ReactElement {
  const { t } = props
  const [open, setOpen] = useState(false)
  const entries = props.history === null ? [] : props.history.entries.slice(0, 10)

  return (
    <Card
      title={t('historyTitle')}
      description={open ? t('historyDesc') : undefined}
      trailing={
        <div className="dgs-btnRow">
          <span className="dgs-hint">{t('historyCount', { count: entries.length })}</span>
          <button
            type="button"
            className="dgs-disclosure"
            aria-expanded={open}
            aria-controls="dgs-history-body"
            onClick={() => {
              setOpen(current => !current)
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M4 6.5 8 10.5 12 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{open ? t('pluginsCollapse') : t('pluginsExpand')}</span>
          </button>
        </div>
      }
    >
      {props.error === null ? null : (
        <Banner tone="error">
          {t('historyLoadFailed', { message: props.error })} <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      {props.loading && props.history === null ? <Loading text={t('loading')} /> : null}

      {props.history !== null && entries.length === 0 ? <p className="dgs-hint">{t('historyEmpty')}</p> : null}

      <div id="dgs-history-body" hidden={!open}>
        {entries.length === 0 ? null : (
          <ul className="dgs-historyList">
          {entries.map(entry => {
            const good = isGoodResult(entry.result)
            const hasResult = entry.result !== undefined && entry.result !== null && entry.result !== ''
            const dotTone = !hasResult ? 'dgs-historyDotIdle' : good ? 'dgs-historyDotOk' : 'dgs-historyDotFail'
            return (
              <li className="dgs-historyItem" key={entry.commit}>
                <span className={`dgs-historyDot ${dotTone}`} aria-hidden="true" />
                <div className="dgs-historyMain">
                  <div className="dgs-historyTop">
                    <span className="dgs-historyOp">{operationLabel(t, entry.operation)}</span>
                    <Badge tone={good ? 'success' : hasResult ? 'error' : 'idle'}>
                      {resultLabel(t, entry.result)}
                    </Badge>
                    {entry.pluginCount === undefined ? null : (
                      <span className="dgs-historyMeta">{t('historyPluginsCount', { count: entry.pluginCount })}</span>
                    )}
                    <span className="dgs-historyMeta">{entry.deviceName ?? t('unknown')}</span>
                  </div>
                  {entry.subject === '' ? null : (
                    <span className="dgs-historySubject" title={entry.subject}>
                      {entry.subject}
                    </span>
                  )}
                  <div className="dgs-historyMetaRow">
                    <span className="dgs-mono" title={entry.commit}>
                      {shortCommit(entry.commit)}
                    </span>
                    <span>{formatDateTime(entry.date, t('unknown'))}</span>
                  </div>
                </div>
                <Button
                  small
                  disabled={props.busy}
                  ariaLabel={t('historyRestoreAria', { commit: shortCommit(entry.commit) })}
                  onClick={() => {
                    props.onRestoreCommit(entry.commit)
                  }}
                >
                  {t('historyRestore')}
                </Button>
              </li>
            )
          })}
          </ul>
        )}
      </div>
    </Card>
  )
}
