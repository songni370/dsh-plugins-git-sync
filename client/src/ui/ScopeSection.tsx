/**
 * Standalone "Backup contents" card.
 *
 * The two scopes are independent choices, not repository credentials, so they
 * live above the repository card instead of inside it. Toggling a switch is
 * saved immediately; the repository form keeps its own draft.
 * @module ui/ScopeSection
 */

import type { ReactElement } from 'react'
import type { Translate } from '../i18n'
import { Card, Switch } from './controls'

/** The two supported backup scopes. */
export interface BackupScopeChoice {
  plugins: boolean
  skills: boolean
}

/** Props for {@link ScopeSection}. */
export interface ScopeSectionProps {
  t: Translate
  scopes: BackupScopeChoice
  saving: boolean
  onChange: (next: BackupScopeChoice) => void
}

/** Render the standalone backup-contents card. */
export function ScopeSection(props: ScopeSectionProps): ReactElement {
  const { t, scopes, saving } = props
  return (
    <Card title={t('configScope')}>
      <div className="dgs-scopeSwitches">
        <Switch
          label={t('configScopePlugins')}
          hint={t('configScopePluginsHint')}
          checked={scopes.plugins}
          disabled={saving || (!scopes.skills && scopes.plugins)}
          onChange={checked => {
            props.onChange({ plugins: checked, skills: scopes.skills })
          }}
        />
        <Switch
          label={t('configScopeSkills')}
          hint={t('configScopeSkillsHint')}
          checked={scopes.skills}
          disabled={saving || (!scopes.plugins && scopes.skills)}
          onChange={checked => {
            props.onChange({ plugins: scopes.plugins, skills: checked })
          }}
        />
      </div>
    </Card>
  )
}
