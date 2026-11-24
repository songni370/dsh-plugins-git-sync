/**
 * "Skills" card: the DSH skills deployed on this device.
 *
 * The Host sends names, sizes and backup status only; skill file contents never
 * reach the settings page. The card sits below the plugin list, starts collapsed, and
 * paginates like the plugin list so a large skill library stays manageable.
 * @module ui/SkillsSection
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SkillListResponse, SkillPreferenceUpdate, SkillSummary } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import { formatBytes } from '../format'
import type { Tone } from './controls'
import { Badge, Banner, Button, Card, Checkbox, LinkButton, Loading, Select } from './controls'

/** Rows-per-page choices for the skill list. */
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_STORAGE_KEY = 'dsh-plugins-git-sync.skills-page-size'

/** Copy and tone for every backup status the Host can report for a skill. */
const SKILL_SYNC_META: Record<SkillSummary['syncStatus'], { key: string; tone: Tone }> = {
  synced: { key: 'skillStatusSynced', tone: 'success' },
  'local-only': { key: 'skillStatusLocalOnly', tone: 'idle' },
  'remote-only': { key: 'skillStatusRemoteOnly', tone: 'idle' },
  modified: { key: 'skillStatusModified', tone: 'warn' },
  excluded: { key: 'statusExcluded', tone: 'idle' },
}

/** Remember the user's page size across visits. */
function storedPageSize(): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) ?? '', 10)
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved) ? saved : DEFAULT_PAGE_SIZE
  } catch {
    return DEFAULT_PAGE_SIZE
  }
}

/** Props for {@link SkillsSection}. */
export interface SkillsSectionProps {
  t: Translate
  skills: SkillListResponse | null
  loading: boolean
  error: string | null
  exclusions: ReadonlySet<string>
  busy: boolean
  onToggle: (skill: SkillSummary, next: boolean) => void
  onRefresh: () => void | Promise<unknown>
  /** Apply one preference update for this device's skill declaration. */
  onApplyPreferences?: (updates: SkillPreferenceUpdate[]) => Promise<void>
}

/** Render the deployed-skill list card. */
export function SkillsSection(props: SkillsSectionProps): ReactElement {
  const { t, skills } = props
  const rows = skills === null ? [] : skills.skills
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(storedPageSize)
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)

  useEffect(() => {
    setPage(1)
  }, [pageSize])

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize
  const pageRows = rows.slice(start, start + pageSize)
  const editable = props.onApplyPreferences !== undefined

  async function applySkillPreference(update: SkillPreferenceUpdate): Promise<void> {
    if (props.onApplyPreferences === undefined) return
    setPrefBusy(true)
    setPrefError(null)
    try {
      await props.onApplyPreferences([update])
    } catch (error) {
      setPrefError(error instanceof Error ? error.message : String(error))
    } finally {
      setPrefBusy(false)
    }
  }

  return (
    <Card
      title={t('skillsTitle')}
      description={open ? t('skillsDesc') : undefined}
      trailing={
        <div className="dgs-btnRow">
          <span className="dgs-hint">{t('skillsCount', { count: rows.length })}</span>
          <button
            type="button"
            className="dgs-disclosure"
            aria-expanded={open}
            aria-controls="dgs-skills-body"
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
          {t('skillsLoadFailed', { message: props.error })} <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      {props.loading && skills === null ? <Loading text={t('loading')} /> : null}

      {skills !== null && rows.length === 0 ? <p className="dgs-hint">{t('skillsEmpty')}</p> : null}

      <div id="dgs-skills-body" hidden={!open}>
        {prefError === null ? null : (
          <Banner tone="error">{t('skillPrefsFailed', { message: prefError })}</Banner>
        )}
        {prefBusy ? <p className="dgs-hint">{t('pluginPrefsSaving')}</p> : null}

        <div className="dgs-tableWrap">
          <table className="dgs-table dgs-skillTable">
            <colgroup>
              <col className="dgs-colCheck" />
              <col />
              <col className="dgs-colSkillMeta" />
              <col className="dgs-colStatus" />
              {editable ? <col className="dgs-colPrivate" /> : null}
              {editable ? <col className="dgs-colSkillLocal" /> : null}
            </colgroup>
            <thead>
              <tr>
                <th className="dgs-tableCellCheck">{t('pluginsSyncable')}</th>
                <th>{t('skillsColumnName')}</th>
                <th>{t('skillsColumnMeta')}</th>
                <th>{t('pluginsStatus')}</th>
                {editable ? <th>{t('pluginPrivateColumn')}</th> : null}
                {editable ? <th>{t('skillLocalColumn')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(skill => {
                const excluded = props.exclusions.has(skill.name) || skill.syncStatus === 'excluded'
                const meta = excluded ? SKILL_SYNC_META.excluded : SKILL_SYNC_META[skill.syncStatus] ?? SKILL_SYNC_META['local-only']
                const installed =
                  skill.installed ??
                  (skill.presence === 'both' || skill.presence === 'local-only' || skill.presence === undefined)
                const canInstall =
                  skill.presence === 'both' || skill.presence === 'remote-only' || skill.presence === undefined
                const localOptions = installed
                  ? [{ value: 'uninstall', label: t('skillUninstall') }]
                  : canInstall
                    ? [{ value: 'install', label: t('skillInstall') }]
                    : []
                return (
                  <tr className="dgs-skillItem" key={skill.name}>
                    <td className="dgs-tableCellCheck">
                      <Checkbox
                        checked={!excluded}
                        disabled={props.busy}
                        label={`${t('pluginsSyncable')}: ${skill.name}`}
                        onChange={next => {
                          props.onToggle(skill, next)
                        }}
                      />
                    </td>
                    <td>
                      <span className="dgs-skillName">{skill.name}</span>
                    </td>
                    <td className="dgs-nowrap">
                      <span className="dgs-skillMeta">
                        {t('skillsMeta', { files: skill.files, size: formatBytes(skill.bytes) })}
                      </span>
                    </td>
                    <td className="dgs-nowrap">
                      <Badge tone={meta.tone}>{t(meta.key)}</Badge>
                    </td>
                    {editable ? (
                      <td className="dgs-tableCellCheck">
                        <Checkbox
                          checked={skill.scopeSelfOnly === true}
                          disabled={prefBusy || props.busy}
                          label={`${t('pluginPrivateColumn')}: ${skill.name}`}
                          onChange={next => {
                            void applySkillPreference({ skillName: skill.name, scope: next ? 'self' : 'all' })
                          }}
                        />
                      </td>
                    ) : null}
                    {editable ? (
                      <td className="dgs-nowrap">
                        <Button
                          small
                          disabled={prefBusy || props.busy || (!installed && !canInstall)}
                          loading={prefBusy}
                          onClick={() => {
                            void applySkillPreference({
                              skillName: skill.name,
                              action: installed ? 'uninstall' : 'install',
                            })
                          }}
                        >
                          {installed ? t('skillUninstall') : t('skillInstall')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? null : (
          <div className="dgs-pagination">
            <span className="dgs-hint">
              {t('pluginsPageRange', {
                from: start + 1,
                to: Math.min(start + pageSize, rows.length),
                total: rows.length,
              })}
            </span>
            <div className="dgs-btnRow">
              <div className="dgs-pluginsPageSize">
                <label className="dgs-hint" htmlFor="dgs-skills-page-size">
                  {t('pluginsPageSize')}
                </label>
                <Select
                  id="dgs-skills-page-size"
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
