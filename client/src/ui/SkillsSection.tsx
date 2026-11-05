/**
 * "Skills" card: the DSH skills deployed on this device.
 *
 * The Host sends names and sizes only; skill file contents never reach the
 * settings page. The card sits below the plugin list so both backup scopes are
 * visible in the same place.
 * @module ui/SkillsSection
 */

import type { ReactElement } from 'react'
import type { SkillListResponse } from '../../../src/http/api-types'
import type { Translate } from '../i18n'
import { formatBytes } from '../format'
import { Banner, Button, Card, LinkButton, Loading } from './controls'

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

  return (
    <Card
      title={t('skillsTitle')}
      description={t('skillsDesc')}
      trailing={
        <div className="dgs-btnRow">
          <span className="dgs-hint">{t('skillsCount', { count: rows.length })}</span>
          <Button small onClick={props.onRefresh} disabled={props.loading}>
            {t('refresh')}
          </Button>
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
      {rows.length === 0 ? null : (
        <ul className="dgs-skillList">
          {rows.map(skill => (
            <li className="dgs-skillItem" key={skill.name}>
              <span className="dgs-skillName">{skill.name}</span>
              <span className="dgs-skillMeta">
                {t('skillsMeta', { files: skill.files, size: formatBytes(skill.bytes) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
