/**
 * Dropdown button used by the plugin and skill lists.
 *
 * The menu is rendered in a fixed layer computed from the trigger rect because
 * the table wrapper scrolls horizontally, which would clip an absolutely
 * positioned menu. The trigger always shows the active choice, so the state is
 * readable without opening the menu.
 * @module ui/PreferenceDropdown
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/** One choice inside a {@link PreferenceDropdown}. */
export interface PreferenceOption {
  value: string
  label: string
}

/** Props for {@link PreferenceDropdown}. */
export interface PreferenceDropdownProps {
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
export function PreferenceDropdown(props: PreferenceDropdownProps): ReactElement {
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
        <svg className="dgs-dropdownChevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
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

