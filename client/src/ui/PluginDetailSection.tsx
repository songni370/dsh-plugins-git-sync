/**
 * The compact "Plugin Backup" section on this plugin's own detail page.
 *
 * The native plugin manager owns the detail layout; this contribution only
 * adds one card under it. It replaces the old settings-page card for the
 * optional Backup tab: the switch lives next to the plugin it controls, and
 * the card states the backup scope without repeating the full settings page.
 * @module ui/PluginDetailSection
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  pluginsTabEnabled,
  setPluginsTabEnabled,
  subscribePluginsTab,
} from '../plugins-tab-visibility'
import type { Translate } from '../i18n'
import { CSS } from '../styles'
import { PACKAGE_NAME } from '../../../src/constants'
import { Badge, Card, Switch } from './controls'

/** The subset of the Host's detail subject this section needs. */
export interface PluginsSubject {
  readonly kind?: string
  readonly pkg?: { readonly name?: string }
  readonly id?: string
}

/** Props injected by the detail slot. */
export interface PluginDetailSectionProps {
  t: Translate
  subject?: PluginsSubject
}

/** True only on this plugin's bundle page. */
export function isOurPluginSubject(subject: PluginsSubject | undefined): boolean {
  return subject?.kind === 'bundle' && subject.pkg?.name === PACKAGE_NAME
}

/** One card: scope plus the movable "show Backup tab" switch. */
export function PluginDetailSection({ t, subject }: PluginDetailSectionProps): ReactElement | null {
  const [tabEnabled, setTabEnabled] = useState<boolean>(pluginsTabEnabled)

  useEffect(
    () => subscribePluginsTab(() => setTabEnabled(pluginsTabEnabled())),
    [],
  )

  if (!isOurPluginSubject(subject)) return null

  return (
    <div className="dgs-root dgs-detailSection">
      <style>{CSS}</style>
      <Card
        title={t('detailTitle')}
        description={t('detailDesc')}
        trailing={<Badge tone="idle">{t('configScopeValue')}</Badge>}
      >
        <Switch
          label={t('tabVisibilityLabel')}
          hint={t('tabVisibilityHint')}
          checked={tabEnabled}
          onChange={setPluginsTabEnabled}
        />
      </Card>
    </div>
  )
}
