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
import type { SkillListResponse, SkillSummary } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import { formatBytes } from '../format'
import type { Tone } from './controls'
import { Badge, Banner, Button, Card, LinkButton, Loading, Select } from './controls'

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
  onRefresh: () => void
}

/** Render the deployed-skill list card. */
export function SkillsSection(props: SkillsSectionProps): ReactElement {
  const { t, skills } = props
  const rows = skills === null ? [] : skills.skills
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(storedPageSize)

  useEffect(() => {
    setPage(1)
  }, [pageSize])

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize
  const pageRows = rows.slice(start, start + pageSize)

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
        <ul className="dgs-skillList">
          {pageRows.map(skill => {
            const meta = SKILL_SYNC_META[skill.syncStatus] ?? SKILL_SYNC_META['local-only']
            return (
              <li className="dgs-skillItem" key={skill.name}>
                <span className="dgs-skillName">{skill.name}</span>
                <span className="dgs-skillTail">
                  <span className="dgs-skillMeta">
                    {t('skillsMeta', { files: skill.files, size: formatBytes(skill.bytes) })}
                  </span>
                  <Badge tone={meta.tone}>{t(meta.key)}</Badge>
                </span>
              </li>
            )
          })}
        </ul>

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
