/**
 * "Plugins" card: this device's plugins joined with the repository state.
 *
 * The list starts expanded. Each row has one selection checkbox for bulk
 * actions plus two destination checkboxes in the 操作 column: 公共 (the public
 * pool; the default) and 本设备 (backed up only from this device). Conflict
 * rows swap the checkboxes for the conflict resolution control in the status
 * cell. A multi-selection can switch the whole selection in one commit.
 * @module ui/PluginsSection
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PluginListResponse, PluginListRow, PluginPreferenceUpdate } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import type { Tone } from './controls'
import { Badge, Banner, Button, Card, Checkbox, LinkButton, Loading, Select } from './controls'
import { PreferenceDropdown } from './PreferenceDropdown'

/** Rows-per-page choices for the plugin table. */
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_STORAGE_KEY = 'dsh-plugins-git-sync.plugins-page-size'
/** Pre-rename key; read once so an upgrade keeps the saved page size. */
const LEGACY_PAGE_SIZE_STORAGE_KEY = 'dsh-git-plugin-sync.plugins-page-size'

/** Remember the user's page size across visits. */
function storedPageSize(): number {
  try {
    const saved = Number.parseInt(
      window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_PAGE_SIZE_STORAGE_KEY) ??
        '',
      10,
    )
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved) ? saved : DEFAULT_PAGE_SIZE
  } catch {
    return DEFAULT_PAGE_SIZE
  }
}

/** Copy + tone for every sync status the Host reports for one row. */
const SYNC_META: Record<PluginListRow['syncStatus'], { key: string; tone: Tone }> = {
  synced: { key: 'statusSynced', tone: 'success' },
  'local-only': { key: 'statusLocalOnly', tone: 'idle' },
  'remote-only': { key: 'statusRemoteOnly', tone: 'idle' },
  'version-diff': { key: 'statusVersionDiff', tone: 'warn' },
  'config-diff': { key: 'statusConfigDiff', tone: 'warn' },
  'enabled-diff': { key: 'statusEnabledDiff', tone: 'warn' },
  conflict: { key: 'statusConflict', tone: 'error' },
  excluded: { key: 'statusExcluded', tone: 'idle' },
}

/** Props for {@link PluginsSection}. */
export interface PluginsSectionProps {
  t: Translate
  plugins: PluginListResponse | null
  loading: boolean
  error: string | null
  filter: string
  /** Ids the user excluded from sync (optimistic, mirrored by config). */
  exclusions: ReadonlySet<string>
  /** An exclusion save is in flight. */
  busy: boolean
  onFilterChange: (value: string) => void
  onToggle: (row: PluginListRow, next: boolean) => void
  onRefresh: () => void | Promise<unknown>
  /** Apply preference updates for one row or a multi-row selection. */
  onApplyPreferences?: (updates: PluginPreferenceUpdate[]) => Promise<void>
  /** Resolve one conflicting plugin from its row. */
  onResolveConflict?: (pluginId: string, choice: 'local' | 'remote') => Promise<void>
}

/** Map a conflict reason to the i18n key used as the row action's title. */
function conflictReasonKey(reason: string): string {
  if (reason === 'local-deleted') return 'conflictReasonLocalDeleted'
  if (reason === 'remote-deleted') return 'conflictReasonRemoteDeleted'
  return 'conflictReasonGeneric'
}

/** Choices a row's conflict dropdown offers for the given reason. */
function conflictOptions(t: Translate, reason: string): { value: string; label: string }[] {
  if (reason === 'local-deleted') {
    return [
      { value: 'remote', label: t('conflictResolveUseRemote') },
      { value: 'local', label: t('conflictResolveDeleteRemote') },
    ]
  }
  if (reason === 'remote-deleted') {
    return [
      { value: 'local', label: t('conflictResolveRestoreLocal') },
      { value: 'remote', label: t('conflictResolveRemoveLocal') },
    ]
  }
  return [
    { value: 'local', label: t('conflictResolveUseLocal') },
    { value: 'remote', label: t('conflictResolveUseRemote') },
  ]
}

/** Render the plugin list card. */
export function PluginsSection(props: PluginsSectionProps): ReactElement {
  const { t } = props
  const rows = props.plugins === null ? [] : props.plugins.rows
  const needle = props.filter.trim().toLowerCase()
  const visible =
    needle === ''
      ? rows
      : rows.filter(row => `${row.displayName ?? ''}\n${row.name}\n${row.id}`.toLowerCase().includes(needle))

  const [open, setOpen] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(storedPageSize)
  // A new filter or page size always starts from the first page.
  useEffect(() => {
    setPage(1)
  }, [props.filter, pageSize])

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize
  const pageRows = visible.slice(start, start + pageSize)

  // Multi-row selection for "apply this preference to everything selected".
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)

  function eligibleRow(row: PluginListRow): boolean {
    return row.local !== undefined && row.syncable && !props.busy
  }

  // Selections only exist for actionable rows; pruning keeps a bulk action
  // from touching rows that became remote-only or busy in the meantime.
  useEffect(() => {
    setSelected(current => {
      if (current.size === 0) return current
      const applicable = new Set(rows.filter(row => row.local !== undefined && row.syncable).map(row => row.id))
      const next = new Set([...current].filter(id => applicable.has(id)))
      return next.size === current.size ? current : next
    })
  }, [rows])

  const selectedRows = rows.filter(row => selected.has(row.id) && eligibleRow(row))

  function toggleSelected(id: string): void {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectPage(): void {
    const pageEligible = pageRows.filter(eligibleRow)
    setSelected(current => {
      const allSelected = pageEligible.length > 0 && pageEligible.every(row => current.has(row.id))
      const next = new Set(current)
      for (const row of pageEligible) {
        if (allSelected) next.delete(row.id)
        else next.add(row.id)
      }
      return next
    })
  }

  async function applyPreferences(updates: PluginPreferenceUpdate[]): Promise<void> {
    if (updates.length === 0 || props.onApplyPreferences === undefined) return
    setPrefBusy(true)
    setPrefError(null)
    try {
      await props.onApplyPreferences(updates)
      setSelected(new Set())
    } catch (error) {
      setPrefError(error instanceof Error ? error.message : String(error))
    } finally {
      setPrefBusy(false)
    }
  }

  /** Resolve one conflict; the row keeps its options visible until the call ends. */
  async function resolveConflict(pluginId: string, choice: 'local' | 'remote'): Promise<void> {
    if (props.onResolveConflict === undefined) return
    setPrefBusy(true)
    setPrefError(null)
    try {
      await props.onResolveConflict(pluginId, choice)
    } catch (error) {
      setPrefError(error instanceof Error ? error.message : String(error))
    } finally {
      setPrefBusy(false)
    }
  }

  return (
      <Card
      title={t('pluginsTitle')}
      description={open ? t('pluginsDesc') : undefined}
      trailing={
        <div className="dgs-btnRow">
          <span className="dgs-hint">{t('pluginsCount', { count: rows.length })}</span>
          <button
            type="button"
            className="dgs-disclosure"
            aria-expanded={open}
            aria-controls="dgs-plugins-body"
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
          {t('pluginsLoadFailed', { message: props.error })} <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      <div
        id="dgs-plugins-body"
        className="dgs-pluginsBody"
        hidden={!open}
        style={open ? undefined : { display: 'none' }}
      >
      <label className="dgs-srOnly" htmlFor="dgs-plugins-filter">
        {t('pluginsFilterPlaceholder')}
      </label>
      <div className="dgs-pluginsFilterRow">
        <input
          id="dgs-plugins-filter"
          className="dgs-input dgs-pluginsFilterInput"
          type="search"
          value={props.filter}
          placeholder={t('pluginsFilterPlaceholder')}
          onChange={event => {
            props.onFilterChange(event.target.value)
            // Typing a filter is a request to see the list.
            setOpen(true)
          }}
        />
        <Button small onClick={props.onRefresh} disabled={props.loading || props.busy} loading={props.loading}>
          {t('pluginsRefresh')}
        </Button>
      </div>

      {prefError === null ? null : (
        <Banner tone="error">{t('pluginPrefsFailed', { message: prefError })}</Banner>
      )}

      {prefBusy ? <p className="dgs-hint">{t('pluginPrefsSaving')}</p> : null}

      {props.onApplyPreferences === undefined || selectedRows.length === 0 ? null : (
        <div className="dgs-bulkBar">
          <span className="dgs-hint">{t('pluginPrefsBulkSelected', { count: selectedRows.length })}</span>
          <Button
            small
            disabled={prefBusy || props.busy}
            loading={prefBusy}
            onClick={() => {
              void applyPreferences(selectedRows.map(row => ({ pluginId: row.id, scope: 'self' })))
            }}
          >
            {t('pluginBulkPrivate')}
          </Button>
          <Button
            small
            disabled={prefBusy || props.busy}
            loading={prefBusy}
            onClick={() => {
              void applyPreferences(selectedRows.map(row => ({ pluginId: row.id, scope: 'all' })))
            }}
          >
            {t('pluginBulkPublic')}
          </Button>
          <Button small onClick={() => setSelected(new Set())} disabled={prefBusy}>
            {t('pluginPrefsBulkClear')}
          </Button>
        </div>
      )}

      {props.loading && props.plugins === null ? <Loading text={t('loading')} /> : null}

      {rows.length === 0 && !props.loading && props.error === null ? (
        <p className="dgs-hint">{t('pluginsEmpty')}</p>
      ) : null}

      {rows.length > 0 && visible.length === 0 ? <p className="dgs-hint">{t('pluginsNoMatch')}</p> : null}

      {visible.length === 0 ? null : (
        <div className="dgs-tableWrap">
          <table className="dgs-table">
            <colgroup>
              <col className="dgs-colCheck" />
              <col />
              <col className="dgs-colVersion" />
              <col className="dgs-colVersion" />
              <col className="dgs-colStatus" />
              <col className="dgs-colActions" />
            </colgroup>
            <thead>
              <tr>
                <th className="dgs-tableCellCheck">
                  <Checkbox
                    checked={
                      pageRows.length > 0 &&
                      pageRows.filter(eligibleRow).length > 0 &&
                      pageRows.filter(eligibleRow).every(row => selected.has(row.id))
                    }
                    disabled={props.busy || pageRows.filter(eligibleRow).length === 0}
                    label={t('pluginPrefsSelectAll')}
                    onChange={toggleSelectPage}
                  />
                </th>
                <th>{t('pluginsName')}</th>
                <th>{t('pluginsLocalVersion')}</th>
                <th>{t('pluginsRemoteVersion')}</th>
                <th>{t('pluginsStatus')}</th>
                <th>{t('pluginsActions')}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(row => {
                const excluded = props.exclusions.has(row.id) || row.syncStatus === 'excluded'
                const meta = SYNC_META[row.syncStatus] ?? SYNC_META.excluded
                const localVersion = row.local?.version ?? row.version
                const remoteVersion = row.remoteVersion ?? row.remote?.version ?? null
                const conflict = row.conflictInfo
                const actionsDisabled = prefBusy || props.busy
                return (
                  <tr key={row.id}>
                    <td className="dgs-tableCellCheck">
                      <Checkbox
                        checked={selected.has(row.id)}
                        disabled={!eligibleRow(row)}
                        label={t('pluginPrefsSelectRow', { name: row.displayName ?? row.name })}
                        onChange={() => {
                          toggleSelected(row.id)
                        }}
                      />
                    </td>
                    <td>
                      <span className="dgs-pluginCell">
                        <span className="dgs-pluginLine">
                          <span className="dgs-pluginName" title={row.displayName ?? row.name}>
                            {row.displayName ?? row.name}
                          </span>
                        </span>
                        {row.id === (row.displayName ?? row.name) ? null : (
                          <span className="dgs-pluginId dgs-mono" title={row.id}>
                            {row.id}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="dgs-nowrap dgs-mono" title={t('pluginsLocalVersion')}>
                      {localVersion === null || localVersion === '' ? t('notAvailable') : localVersion}
                    </td>
                    <td className="dgs-nowrap dgs-mono dgs-versionRemote" title={t('pluginsRemoteVersion')}>
                      {remoteVersion === null || remoteVersion === '' ? t('notAvailable') : remoteVersion}
                    </td>
                    <td className="dgs-nowrap">
                      {conflict === undefined ? (
                        <Badge tone={excluded ? 'idle' : meta.tone}>
                          {excluded ? t('statusExcluded') : t(meta.key)}
                        </Badge>
                      ) : (
                        <PreferenceDropdown
                          label={t('conflictResolve')}
                          ariaLabel={`${t('conflictResolve')}: ${row.displayName ?? row.name}`}
                          title={t(conflictReasonKey(conflict.reason))}
                          disabled={actionsDisabled}
                          busy={prefBusy}
                          options={conflictOptions(t, conflict.reason)}
                          onSelect={value => {
                            if (value === 'local' || value === 'remote') {
                              void resolveConflict(row.id, value)
                            }
                          }}
                        />
                      )}
                    </td>
                    <td className="dgs-nowrap">
                      <span className="dgs-scopeChecks">
                        <label className="dgs-scopeCheck">
                          <Checkbox
                            checked={row.scopeSelfOnly !== true}
                            disabled={actionsDisabled || conflict !== undefined || !eligibleRow(row)}
                            label={`${t('pluginScopePublicCheck')}: ${row.displayName ?? row.name}`}
                            onChange={() => {
                              if (row.scopeSelfOnly === true) {
                                void applyPreferences([{ pluginId: row.id, scope: 'all' }])
                              }
                            }}
                          />
                          <span>{t('pluginScopePublicCheck')}</span>
                        </label>
                        <label className="dgs-scopeCheck">
                          <Checkbox
                            checked={row.scopeSelfOnly === true}
                            disabled={actionsDisabled || conflict !== undefined || !eligibleRow(row)}
                            label={`${t('pluginScopePrivateCheck')}: ${row.displayName ?? row.name}`}
                            onChange={() => {
                              if (row.scopeSelfOnly !== true) {
                                void applyPreferences([{ pluginId: row.id, scope: 'self' }])
                              }
                            }}
                          />
                          <span>{t('pluginScopePrivateCheck')}</span>
                        </label>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {visible.length === 0 ? null : (
        <div className="dgs-pagination">
          <span className="dgs-hint">
            {t('pluginsPageRange', {
              from: start + 1,
              to: Math.min(start + pageSize, visible.length),
              total: visible.length,
            })}
          </span>
          <div className="dgs-btnRow">
            <div className="dgs-pluginsPageSize">
              <label className="dgs-hint" htmlFor="dgs-plugins-page-size">
                {t('pluginsPageSize')}
              </label>
              <Select
                id="dgs-plugins-page-size"
                className="dgs-pageSizeSelect"
                value={String(pageSize)}
                options={PAGE_SIZE_OPTIONS.map(size => ({ value: String(size), label: String(size) }))}
                onChange={value => {
                  const next = Number.parseInt(value, 10)
                  setPageSize(next)
                  try {
                    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next))
                  } catch {
                    // Storage can be unavailable in private mode; the choice
                    // still applies for this visit.
                  }
                }}
              />
            </div>
            {totalPages <= 1 ? null : (
              <>
                <Button small onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>
                  {t('pluginsPagePrev')}
                </Button>
                <span className="dgs-hint">{t('pluginsPageInfo', { page: currentPage, pages: totalPages })}</span>
                <Button small onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages}>
                  {t('pluginsPageNext')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      </div>
      </Card>
    )
}

