/**
 * "Sync status" card: the device/repository state at a glance.
 *
 * The badge tone is derived from the Host's `SyncState` (never from counts
 * recomputed here), so the page and the Host cannot disagree about what
 * "ahead" means. Counts are a compact tile row; device/repository metadata is a
 * two-column definition grid whose values are single-line and ellipsised, so a
 * long device name, branch or commit cannot reflow the card.
 * @module ui/StatusSection
 */

import type { ReactElement, ReactNode } from 'react'
import type { SkillListResponse } from '../../../src/http/api-types'
import type { SyncState, StatusView } from '../../../src/types'
import type { Translate } from '../i18n'
import { formatDateTime, operationLabel, resultLabel, shortCommit } from '../format'
import { Badge, Card } from './controls'
import type { Tone } from './controls'

/** Copy + tone for every Host sync state. */
const STATE_META: Record<SyncState, { key: string; tone: Tone }> = {
  'not-configured': { key: 'stateNotConfigured', tone: 'idle' },
  synced: { key: 'stateSynced', tone: 'success' },
  ahead: { key: 'stateAhead', tone: 'warn' },
  behind: { key: 'stateBehind', tone: 'warn' },
  diverged: { key: 'stateDiverged', tone: 'warn' },
  conflict: { key: 'stateConflict', tone: 'error' },
  error: { key: 'stateError', tone: 'error' },
  syncing: { key: 'stateSyncing', tone: 'idle' },
  unknown: { key: 'stateUnknown', tone: 'idle' },
}

/** One count tile; `tone` marks attention-worthy numbers. */
interface CountTile {
  key: string
  value: string
  label: string
  tone?: 'warn' | 'error'
}

/** Props for {@link StatusSection}. */
export interface StatusSectionProps {
  t: Translate
  status: StatusView
  /** Render inside another card (operations) instead of as its own card. */
  embedded?: boolean
  /** Deployed and repository skills, used for the compact skill progress line. */
  skills?: SkillListResponse | null
}

/** One metadata cell (label above a single-line value). */
function MetaCell(props: { label: string; value: ReactNode; title?: string; wrap?: boolean }): ReactElement {
  return (
    <div className="dgs-statusMetaItem">
      <span className="dgs-statusMetaLabel">{props.label}</span>
      <span
        className={props.wrap === true ? 'dgs-statusMetaValue dgs-statusMetaValueWrap' : 'dgs-statusMetaValue'}
        title={props.title}
      >
        {props.value}
      </span>
    </div>
  )
}

/** Render the sync-status card. */
export function StatusSection(props: StatusSectionProps): ReactElement {
  const { t, status } = props
  const meta = STATE_META[status.state] ?? STATE_META.unknown
  const connection = status.connection

  const lastOperation: string =
    status.lastOperation === null
      ? t('notAvailable')
      : `${operationLabel(t, status.lastOperation.operation)} · ${resultLabel(
          t,
          status.lastOperation.ok ? 'ok' : 'failed',
        )} · ${formatDateTime(status.lastOperation.at, t('unknown'))}`

  const pluginTiles: CountTile[] = [
    { key: 'local-plugins', value: String(status.localPluginCount), label: t('statusLocalPlugins') },
    {
      key: 'remote-plugins',
      value: status.remotePluginCount === null ? '—' : String(status.remotePluginCount),
      label: t('statusRemotePlugins'),
    },
    {
      key: 'pending-up',
      value: String(status.pendingUploads),
      label: t('statusPendingUp'),
      ...(status.pendingUploads > 0 ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'pending-down',
      value: String(status.pendingDownloads),
      label: t('statusPendingDown'),
      ...(status.pendingDownloads > 0 ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'conflicts',
      value: String(status.conflictCount),
      label: t('statusConflicts'),
      ...(status.conflictCount > 0 ? { tone: 'error' as const } : {}),
    },
  ]

  const skillRows = props.skills?.skills ?? []
  const localSkillCount = skillRows.filter(skill =>
    skill.presence === undefined ? skill.syncStatus !== 'remote-only' : skill.presence !== 'remote-only',
  ).length
  const remoteSkillCount = skillRows.filter(skill =>
    skill.presence === undefined ? skill.syncStatus !== 'local-only' : skill.presence !== 'local-only',
  ).length
  const skillPendingUp = skillRows.filter(
    skill => skill.syncStatus === 'local-only' || skill.syncStatus === 'modified',
  ).length
  const skillPendingDown = skillRows.filter(skill => skill.syncStatus === 'remote-only').length
  const skillExcluded = skillRows.filter(skill => skill.syncStatus === 'excluded').length
  const skillTiles: CountTile[] = [
    { key: 'local-skills', value: String(localSkillCount), label: t('statusLocalSkills') },
    { key: 'remote-skills', value: String(remoteSkillCount), label: t('statusRemoteSkills') },
    {
      key: 'skills-pending-up',
      value: String(skillPendingUp),
      label: t('statusPendingUp'),
      ...(skillPendingUp > 0 ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'skills-pending-down',
      value: String(skillPendingDown),
      label: t('statusPendingDown'),
      ...(skillPendingDown > 0 ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'skills-excluded',
      value: String(skillExcluded),
      label: t('statusSkillExcluded'),
    },
  ]

  const showPlugins = status.config.backupScopes?.plugins !== false
  const showSkills = status.config.backupScopes?.skills !== false && props.skills !== null && props.skills !== undefined

  function renderTiles(tiles: CountTile[], className: string): ReactElement {
    return (
      <div className={className}>
        {tiles.map(tile => (
          <div
            key={tile.key}
            className={
              tile.tone === undefined
                ? 'dgs-statusTile'
                : `dgs-statusTile ${tile.tone === 'error' ? 'dgs-statusTileError' : 'dgs-statusTileWarn'}`
            }
          >
            <span className="dgs-statusTileValue">{tile.value}</span>
            <span className="dgs-statusTileLabel">{tile.label}</span>
          </div>
        ))}
      </div>
    )
  }

  const body = (
    <>
      {showPlugins ? renderTiles(pluginTiles, 'dgs-statusTiles') : null}
      {showSkills ? renderTiles(skillTiles, 'dgs-statusTiles dgs-statusTilesSkills') : null}

      <div className="dgs-statusMeta">
        <MetaCell label={t('statusDevice')} value={status.config.device.name} title={status.config.device.name} />
        <MetaCell
          label={t('statusBranch')}
          value={status.branch === '' ? t('notAvailable') : status.branch}
          title={status.branch}
        />
        <MetaCell label={t('statusLastSync')} value={formatDateTime(status.lastSyncAt, t('never'))} />
        <MetaCell
          label={t('statusLastCommit')}
          value={
            status.lastCommit === null ? (
              t('notAvailable')
            ) : (
              <span className="dgs-mono">{shortCommit(status.lastCommit)}</span>
            )
          }
          title={status.lastCommit ?? undefined}
        />
        <MetaCell label={t('statusLastOperation')} value={lastOperation} title={lastOperation} />
        <MetaCell
          label={t('statusConnection')}
          wrap={connection !== null && !connection.ok}
          title={connection === null ? undefined : connection.message}
          value={
            connection === null ? (
              t('notAvailable')
            ) : (
              <span className="dgs-statusConnection">
                <Badge tone={connection.ok ? 'success' : 'error'}>
                  {connection.ok ? t('statusConnectionOk') : t('statusConnectionFail')}
                </Badge>
                <span className="dgs-statusConnectionText">
                  {connection.ok ? formatDateTime(connection.at, t('unknown')) : connection.message}
                </span>
              </span>
            )
          }
        />
      </div>

    </>
  )

  if (props.embedded === true) {
    return (
      <div className="dgs-syncStatusBlock">
        <div className="dgs-syncStatusHead">
          <span className="dgs-syncStatusTitle">{t('statusTitle')}</span>
          <Badge tone={meta.tone}>{t(meta.key)}</Badge>
        </div>
        {body}
      </div>
    )
  }

  return (
    <Card
      title={t('statusTitle')}
      description={t('statusDesc')}
      trailing={<Badge tone={meta.tone}>{t(meta.key)}</Badge>}
    >
      {body}
    </Card>
  )
}
