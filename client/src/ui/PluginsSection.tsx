/**
 * "Plugins" card: this device's plugins joined with the repository state, plus
 * the per-row sync switch and inline per-device preference actions.
 *
 * The switch is a check on top of the Host payload: it displays
 * `syncable`/`syncStatus` from `/plugins/list` and persists a change through
 * `config/save`'s `excludedPlugins` (the only exclusion endpoint the contract
 * has). Turning it off never uninstalls anything — it stops future syncs.
 * The per-row controls edit this device's declaration directly, without a
 * second dialog: availability (all devices vs this device only) and a local
 * enabled override. Each control is a dropdown button that shows the active
 * choice and opens its options on click. Rows can be multi-selected so one
 * preference applies to a whole selection in a single repository commit.
 * @module ui/PluginsSection
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PluginListResponse, PluginListRow, PluginPreferenceUpdate } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import type { Tone } from './controls'
import { Badge, Banner, Button, Card, Checkbox, LinkButton, Loading, Select } from './controls'

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

/** One choice inside a {@link PreferenceDropdown}. */
interface PreferenceOption {
  value: string
  label: string
}

/** Props for {@link PreferenceDropdown}. */
interface PreferenceDropdownProps {
  /** Text on the trigger: the active choice, or a section name for bulk edits. */
  label: string
  ariaLabel: string
  title?: string
  options: readonly PreferenceOption[]
  /** Value marked as checked in the menu; omitted for bulk dropdowns. */
  current?: string
  disabled?: boolean
  onSelect: (value: string) => void
}

/**
 * Small dropdown button used by the plugin list. The menu is rendered in a
 * fixed layer computed from the trigger rect because the table wrapper scrolls
 * horizontally, which would clip an absolutely positioned menu.
 */
function PreferenceDropdown(props: PreferenceDropdownProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    function close(): void {
      setOpen(false)
    }
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) === true) return
      if (menuRef.current?.contains(target) === true) return
      close()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  function toggle(): void {
    if (props.disabled === true) return
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const width = Math.max(rect.width, 148)
    setPosition({
      top: rect.bottom + 4,
      left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
      minWidth: width,
    })
    setOpen(true)
  }

  return (
    <span className="dgs-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className="dgs-prefBtn dgs-dropdownToggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled === true}
        onClick={toggle}
      >
        <span className="dgs-dropdownLabel">{props.label}</span>
        <svg className="dgs-dropdownChevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path
            d="M4 6.5 8 10.5 12 6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && position !== null ? (
        <div
          ref={menuRef}
          className="dgs-dropdownMenu"
          role="menu"
          aria-label={props.ariaLabel}
          style={{ top: position.top, left: position.left, minWidth: position.minWidth }}
        >
          {props.options.map(option => {
            const checked = props.current === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="dgs-dropdownItem"
                onClick={() => {
                  setOpen(false)
                  if (!checked) props.onSelect(option.value)
                }}
              >
                <span className="dgs-dropdownItemCheck" aria-hidden="true">
                  {checked ? '✓' : ''}
                </span>
                {option.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </span>
  )
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
  onRefresh: () => void
  /** Apply preference updates for one row or a multi-row selection. */
  onApplyPreferences?: (updates: PluginPreferenceUpdate[]) => Promise<void>
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

  const [open, setOpen] = useState(false)
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
          <PreferenceDropdown
            label={t('pluginPrefsBulkScope')}
            ariaLabel={t('pluginPrefsBulkScope')}
            title={t('pluginPrefsScopeHint')}
            disabled={prefBusy || props.busy}
            options={[
              { value: 'all', label: t('pluginPrefsScopeAll') },
              { value: 'self', label: t('pluginPrefsScopeSelf') },
            ]}
            onSelect={value => {
              const scope = value === 'self' ? ('self' as const) : ('all' as const)
              void applyPreferences(selectedRows.map(row => ({ pluginId: row.id, scope })))
            }}
          />
          <PreferenceDropdown
            label={t('pluginPrefsBulkEnabled')}
            ariaLabel={t('pluginPrefsBulkEnabled')}
            title={t('pluginPrefsEnabledHint')}
            disabled={prefBusy || props.busy}
            options={[
              { value: 'follow', label: t('pluginPrefsEnabledFollow') },
              { value: 'on', label: t('pluginPrefsEnabledOn') },
              { value: 'off', label: t('pluginPrefsEnabledOff') },
            ]}
            onSelect={value => {
              const enabledOverride = value === 'follow' ? null : value === 'on'
              void applyPreferences(selectedRows.map(row => ({ pluginId: row.id, enabledOverride })))
            }}
          />
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
              <col className="dgs-colSync" />
              <col />
              <col className="dgs-colVersion" />
              <col className="dgs-colVersion" />
              <col className="dgs-colStatus" />
              {props.onApplyPreferences === undefined ? null : <col className="dgs-colPrefs" />}
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
                <th className="dgs-tableCellCheck">{t('pluginsSyncable')}</th>
                <th>{t('pluginsName')}</th>
                <th>{t('pluginsLocalVersion')}</th>
                <th>{t('pluginsRemoteVersion')}</th>
                <th>{t('pluginsStatus')}</th>
                {props.onApplyPreferences === undefined ? null : <th>{t('pluginPrefsColumn')}</th>}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(row => {
                const excluded = props.exclusions.has(row.id) || row.syncStatus === 'excluded'
                const checked = row.syncable && !excluded
                const meta = SYNC_META[row.syncStatus] ?? SYNC_META.excluded
                const localVersion = row.local?.version ?? row.version
                const remoteVersion = row.remoteVersion ?? row.remote?.version ?? null
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
                    <td className="dgs-tableCellCheck">
                      <Checkbox
                        checked={checked}
                        disabled={!row.syncable || props.busy}
                        label={
                          row.syncable
                            ? `${t('pluginsSyncable')}: ${row.displayName ?? row.name}`
                            : `${t('pluginsNotSyncable')}: ${row.displayName ?? row.name}`
                        }
                        onChange={next => {
                          props.onToggle(row, next)
                        }}
                      />
                    </td>
                    <td>
                      <span className="dgs-pluginCell">
                        <span className="dgs-pluginName" title={row.displayName ?? row.name}>
                          {row.displayName ?? row.name}
                        </span>
                        {row.id === (row.displayName ?? row.name) ? null : (
                          <span className="dgs-pluginId dgs-mono" title={row.id}>
                            {row.id}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="dgs-nowrap dgs-mono" title={localVersion ?? undefined}>
                      {localVersion === null || localVersion === '' ? t('notAvailable') : localVersion}
                    </td>
                    <td className="dgs-nowrap dgs-mono" title={remoteVersion ?? undefined}>
                      {remoteVersion === null || remoteVersion === '' ? t('notAvailable') : remoteVersion}
                    </td>
                    <td className="dgs-nowrap">
                      <span className="dgs-pluginBadges">
                        <Badge tone={excluded ? 'idle' : meta.tone}>{excluded ? t('statusExcluded') : t(meta.key)}</Badge>
                      </span>
                    </td>
                    {props.onApplyPreferences === undefined ? null : (
                      <td className="dgs-nowrap">
                        {row.local === undefined || !row.syncable ? null : (
                          <span className="dgs-prefCell">
                            <PreferenceDropdown
                              label={row.scopeSelfOnly === true ? t('pluginPrefsScopeSelf') : t('pluginPrefsScopeAll')}
                              ariaLabel={`${t('pluginPrefsScope')}: ${row.displayName ?? row.name}`}
                              title={t('pluginPrefsScopeHint')}
                              current={row.scopeSelfOnly === true ? 'self' : 'all'}
                              disabled={prefBusy || props.busy}
                              options={[
                                { value: 'all', label: t('pluginPrefsScopeAll') },
                                { value: 'self', label: t('pluginPrefsScopeSelf') },
                              ]}
                              onSelect={value => {
                                const scope = value === 'self' ? ('self' as const) : ('all' as const)
                                void applyPreferences([{ pluginId: row.id, scope }])
                              }}
                            />
                            <PreferenceDropdown
                              label={
                                row.enabledOverride === true
                                  ? t('pluginPrefsEnableShort')
                                  : row.enabledOverride === false
                                    ? t('pluginPrefsDisableShort')
                                    : t('pluginPrefsFollowShort')
                              }
                              ariaLabel={`${t('pluginPrefsEnabled')}: ${row.displayName ?? row.name}`}
                              title={t('pluginPrefsEnabledHint')}
                              current={row.enabledOverride === undefined ? 'follow' : row.enabledOverride ? 'on' : 'off'}
                              disabled={prefBusy || props.busy}
                              options={[
                                { value: 'follow', label: t('pluginPrefsEnabledFollow') },
                                { value: 'on', label: t('pluginPrefsEnabledOn') },
                                { value: 'off', label: t('pluginPrefsEnabledOff') },
                              ]}
                              onSelect={value => {
                                const enabledOverride = value === 'follow' ? null : value === 'on'
                                void applyPreferences([{ pluginId: row.id, enabledOverride }])
                              }}
                            />
                          </span>
                        )}
                      </td>
                    )}
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

