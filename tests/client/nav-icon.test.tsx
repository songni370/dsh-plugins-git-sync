// @vitest-environment jsdom
/**
 * The settings nav glyph is registered through DSH's `settings.section.icon`
 * seat (0.2.2+); the shell renders the component inside its own nav row, so
 * these tests cover the rendered mask and its theme-following colour.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NAV_ICON_SIZE, SettingsNavIcon } from '../../client/src/nav-icon'
import { SETTINGS_ICON_MASK_URL } from '../../client/src/settings-icon-data'

describe('settings nav icon', () => {
  it('paints the designed PNG mask at the requested size', () => {
    const html = renderToStaticMarkup(<SettingsNavIcon size={16} />)
    expect(html).toContain(SETTINGS_ICON_MASK_URL)
    expect(html).toContain('width:16px')
    expect(html).toContain('height:16px')
    // A mask reads alpha only; the colour must follow the nav row.
    expect(html).toContain('background-color:currentColor')
  })

  it('defaults to the shell nav size and stays decorative', () => {
    const html = renderToStaticMarkup(<SettingsNavIcon />)
    expect(html).toContain(`width:${NAV_ICON_SIZE}px`)
    expect(html).toContain('aria-hidden="true"')
  })
})
