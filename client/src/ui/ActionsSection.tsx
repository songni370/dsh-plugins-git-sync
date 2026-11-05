/**
 * "Operations" card: the four manual actions and the read-only difference
 * preview.
 *
 * All actions are delegated to the page: content-changing ones open the
 * confirmation dialog, and "check differences" opens a read-only preview
 * dialog.
 * @module ui/ActionsSection
 */

import type { ReactElement, ReactNode } from 'react'
import type { Translate } from '../i18n'
import { Button, Card } from './controls'

/** Action names used for the busy indicator and disabled set. */
export type ActionName = 'backup' | 'restore' | 'rollback' | 'sync' | 'diff' | 'config' | 'auto' | 'exclusion'

/** Props for {@link ActionsSection}. */
export interface ActionsSectionProps {
  t: Translate
  /** Which operation is running, if any. */
  busy: ActionName | null
  /** The Host reports an operation in flight (status.busy). */
  hostBusy: boolean
  /** Actions need a saved repository URL. */
  enabled: boolean
  onBackup: () => void
  onRestore: () => void
  onSync: () => void
  onDiff: () => void
  /** Automatic-sync panel, merged into this card below the manual actions. */
  autoPanel?: ReactNode
  /** Result of a manual operation, shown inside this card. */
  /** Result of saving auto-sync, shown below the auto-sync panel. */
  /** Sync status content, embedded at the bottom of this card. */
  statusPanel?: ReactNode
  /** State notices (not configured / busy / last error) shown near the actions. */
  notices?: ReactNode
}

/** Render the operations card. */
export function ActionsSection(props: ActionsSectionProps): ReactElement {
  const { t } = props
  const disabled = props.busy !== null || props.hostBusy || !props.enabled
  return (
    <Card title={t('actionsTitle')} description={t('actionsDesc')}>
      <div className="dgs-actionsMain">
        <Button
          variant="primary"
          onClick={props.onSync}
          disabled={disabled}
          loading={props.busy === 'sync'}
          title={t('actionSyncHint')}
        >
          {t('actionSync')}
        </Button>
        <Button
          onClick={props.onDiff}
          disabled={disabled}
          loading={props.busy === 'diff'}
          title={t('actionDiffHint')}
        >
          {t('actionDiff')}
        </Button>
        <Button
          onClick={props.onBackup}
          disabled={disabled}
          loading={props.busy === 'backup'}
          title={t('actionBackupHint')}
        >
          {t('actionBackup')}
        </Button>
        <Button
          onClick={props.onRestore}
          disabled={disabled}
          loading={props.busy === 'restore'}
          title={t('actionRestoreHint')}
        >
          {t('actionRestore')}
        </Button>
      </div>

      {props.notices === undefined ? null : <div className="dgs-actionsNotices">{props.notices}</div>}

      {props.autoPanel === undefined ? null : (
        <div className="dgs-autoSection">{props.autoPanel}</div>
      )}

      {props.statusPanel === undefined ? null : props.statusPanel}
    </Card>
  )
}

