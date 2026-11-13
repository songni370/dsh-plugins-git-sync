/**
 * The settings-navigation glyph for the "插件备份 / Plugin Backup" row.
 *
 * DSH 0.2.2 added the `settings.section.icon` seat, so the icon is registered
 * there (see `client/src/index.tsx`) instead of being painted into the shell's
 * DOM. The shell's fallback gear is replaced by the slot contribution.
 *
 * The artwork is `assets/icon-settings.png`: a black sync/puzzle glyph on
 * transparency. It is used as a CSS mask, so the visible colour comes from
 * `background-color: currentColor` and follows the light/dark theme.
 * @module nav-icon
 */

import type { CSSProperties, ReactElement } from 'react'
import { SETTINGS_ICON_MASK_URL } from './settings-icon-data'

/** Nav glyph box, matching the shell's 16 px section icons. */
export const NAV_ICON_SIZE = 16

/** Props the settings navigation row passes to a section icon. */
export interface SettingsNavIconProps {
  /** Requested square edge in pixels. */
  size?: number
}

/** The sync/puzzle glyph, masked over the current text colour. */
export function SettingsNavIcon({ size }: SettingsNavIconProps): ReactElement {
  const edge = size ?? NAV_ICON_SIZE
  const style: CSSProperties = {
    display: 'inline-block',
    flex: 'none',
    width: edge,
    height: edge,
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url("${SETTINGS_ICON_MASK_URL}")`,
    maskImage: `url("${SETTINGS_ICON_MASK_URL}")`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: `${edge}px ${edge}px`,
    maskSize: `${edge}px ${edge}px`,
  }
  return <span aria-hidden="true" style={style} />
}
