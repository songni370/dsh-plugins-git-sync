/**
 * "Repository" card: where the backup lives and how to authenticate.
 *
 * Layout follows the host's own settings pages: one label column, one control
 * column, short helper text under the control, and secondary options behind an
 * "Advanced" disclosure. Only the two things every setup needs stay visible —
 * the repository address and (for HTTPS) the authentication choice.
 *
 * The token is NEVER a field here. The Host stores the environment variable
 * NAME and reports whether that variable currently holds a value; the page
 * shows the name plus availability and has no way to read or write the secret.
 * @module ui/ConfigSection
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { GitAuthMode, SyncConfig, SyncConfigView } from '../../../src/types'
import type { Translate } from '../i18n'
import {
  authForTransport,
  detectRepoTransport,
  type RepoTransport,
} from '../repo-transport'
import { Badge, Button, Card, Select, TextInput } from './controls'

/** The editable subset of the Host configuration. */
export interface ConfigForm {
  repoUrl: string
  branch: string
  backupDir: string
  authMode: GitAuthMode
  tokenEnvVar: string
  username: string
  deviceName: string
  backupPlugins: boolean
  backupSkills: boolean
}

/** Build the form from the Host's effective configuration view. */
export function configFormFromView(view: SyncConfigView): ConfigForm {
  return {
    repoUrl: view.repoUrl,
    branch: view.branch,
    backupDir: view.backupDir,
    // A legacy HTTPS URL saved with SSH auth (or the reverse) must not render
    // an auth control with no matching option; show the mode that fits.
    authMode: authForTransport(detectRepoTransport(view.repoUrl), view.authMode),
    tokenEnvVar: view.tokenEnvVar,
    username: view.username,
    deviceName: view.deviceName,
    backupPlugins: view.backupScopes?.plugins ?? true,
    backupSkills: view.backupScopes?.skills ?? true,
  }
}

/** Translate the editable form shape into the Host configuration payload. */
export function configPayloadFromForm(form: ConfigForm): Partial<SyncConfig> {
  const { backupPlugins, backupSkills, ...rest } = form
  return { ...rest, backupScopes: { plugins: backupPlugins, skills: backupSkills } }
}

/** One device-name control: type a new name or pick an existing one. */
function DeviceNameInput(props: {
  t: Translate
  value: string
  options: readonly string[]
  disabled: boolean
  onChange: (value: string) => void
}): ReactElement {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const hasOptions = props.options.length > 0

  useEffect(() => {
    if (!open) return undefined
    function close(): void {
      setOpen(false)
    }
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node
      if (wrapperRef.current?.contains(target) === true) return
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
    if (props.disabled) return
    if (open) {
      setOpen(false)
      return
    }
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const width = Math.max(rect.width, 200)
    setPosition({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
    })
    setOpen(true)
  }

  return (
    <div className="dgs-combo" ref={wrapperRef}>
      <input
        id="dgs-config-device"
        className="dgs-input dgs-comboInput"
        type="text"
        value={props.value}
        disabled={props.disabled}
        placeholder={t('configDeviceExisting')}
        onChange={event => {
          props.onChange(event.target.value)
        }}
      />
      {hasOptions ? (
        <button
          type="button"
          className="dgs-comboToggle"
          aria-label={t('configDeviceExisting')}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={props.disabled}
          onClick={toggle}
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
        </button>
      ) : null}
      {open && position !== null ? (
        <div
          className="dgs-comboMenu"
          role="listbox"
          ref={menuRef}
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          {props.options.map(name => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={name === props.value}
              className="dgs-comboItem"
              onClick={() => {
                props.onChange(name)
                setOpen(false)
              }}
            >
              <span>{name}</span>
              {name === props.value ? <span className="dgs-comboCheck">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Props for {@link ConfigSection}. */
export interface ConfigSectionProps {
  t: Translate
  form: ConfigForm
  /** Effective Host view, for token availability and profile names. */
  view: SyncConfigView
  /** The user changed a field since the last save. */
  dirty: boolean
  saving: boolean
  testing: boolean
  /** Known device names in the repository, for the identity selector. */
  deviceNames?: readonly string[]
  /** Result of the last test from this card. */
  onChange: (patch: Partial<ConfigForm>) => void
  onTest: () => void | Promise<unknown>
  onSave: () => void | Promise<unknown>
  /** Whether the form body is expanded. */
  open: boolean
  /** Expand/collapse the card body. */
  onToggle: () => void
  /** Result of testing/saving, shown inside this card. */
}

/** Label + hint for one detected transport. */
function transportMeta(t: Translate, transport: RepoTransport): { label: string; hint: string } {
  switch (transport) {
    case 'https':
      return { label: t('configDetectedHttps'), hint: t('configTransportHttpsHint') }
    case 'ssh':
      return { label: t('configDetectedSsh'), hint: t('configTransportSshHint') }
    case 'local':
      return { label: t('configDetectedLocal'), hint: t('configTransportLocalHint') }
    case 'other':
      return { label: t('configDetectedOther'), hint: t('configTransportOtherHint') }
    case 'none':
      return { label: '', hint: '' }
  }
}

/** One label/control row of the settings-style form. */
function FormRow(props: {
  label: string
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={['dgs-formRow', props.className].filter(Boolean).join(' ')}>
      <span className="dgs-formRowLabel">{props.label}</span>
      <div className="dgs-formRowControl">{props.children}</div>
    </div>
  )
}

/** Repository paths shown while the user configures a repository. */
function repoLocation(backupDir: string, profile: string): { plugins: string; skills: string } {
  const dir = backupDir.trim().replace(/^\/+|\/+$/g, '')
  const prefix = dir === '' ? '' : `${dir}/`
  return {
    plugins: `${prefix}profiles/${profile}/plugins.json`,
    skills: `${prefix}profiles/${profile}/skills/<name>/`,
  }
}

/** Render the repository-configuration card. */
export function ConfigSection(props: ConfigSectionProps): ReactElement {
  const { t, form, view, dirty } = props
  const busy = props.saving || props.testing
  const transport = detectRepoTransport(form.repoUrl)
  const meta = transportMeta(t, transport)
  const effectiveAuth = authForTransport(transport, form.authMode)
  const tokenVisible = transport === 'https' && effectiveAuth === 'https-token'
  // A fresh install opens the secondary options; a configured device keeps the
  // card short and puts them one click away.
  const [advancedOpen, setAdvancedOpen] = useState(() => view.repoUrl.trim() === '')

  const tokenState =
    form.tokenEnvVar !== view.tokenEnvVar ? (
      <Badge tone="idle">{t('configTokenCheckAfterSave')}</Badge>
    ) : view.tokenAvailable ? (
      <Badge tone="success">{t('configTokenAvailable')}</Badge>
    ) : (
      <Badge tone="error">{t('configTokenUnavailable')}</Badge>
    )

  const configured = view.repoUrl.trim() !== ''
  const location = repoLocation(form.backupDir, view.activeProfile)

  return (
    <Card
      title={t('configTitle')}
      description={props.open ? t('configDesc') : undefined}
      trailing={
        <span className="dgs-trailingRow">
          {dirty ? <Badge tone="warn">{t('configUnsaved')}</Badge> : null}
          <Badge tone={configured ? 'success' : 'idle'}>
            {configured ? t('configConfigured') : t('configNotConfigured')}
          </Badge>
          <button
            type="button"
            className="dgs-disclosure"
            aria-expanded={props.open}
            aria-controls="dgs-config-body"
            onClick={props.onToggle}
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
            <span>{props.open ? t('configCollapse') : t('configExpand')}</span>
          </button>
        </span>
      }
    >
      <div id="dgs-config-body" hidden={!props.open}>
        <div className="dgs-formRows">
          <FormRow label={t('configRepoUrl')}>
            <div className="dgs-inlineRow">
              <div className="dgs-grow">
                <TextInput
                  id="dgs-config-repo"
                  value={form.repoUrl}
                  placeholder="https://github.com/you/dsh-plugins.git"
                  disabled={busy}
                  inputMode="url"
                  onChange={value => {
                    props.onChange({ repoUrl: value })
                  }}
                />
              </div>
              <Button
                small
                onClick={props.onTest}
                disabled={busy || form.repoUrl.trim() === ''}
                loading={props.testing}
              >
                {props.testing ? t('configTesting') : t('configTest')}
              </Button>
            </div>
            <div className="dgs-rowMeta">
              {transport === 'none' ? null : <Badge tone="idle">{meta.label}</Badge>}
              <span className="dgs-formRowHint">
                {form.repoUrl.trim() === ''
                  ? t('configRepoUrlHint')
                  : transport === 'https'
                    ? t('configTestFirstHint')
                    : meta.hint}
              </span>
            </div>
          </FormRow>

          {transport === 'https' ? (
            <>
              <FormRow label={t('configAuthMode')}>
                <div
                  id="dgs-config-auth"
                  className="dgs-segmented"
                  role="radiogroup"
                  aria-label={t('configAuthMode')}
                >
                  {([
                    { value: 'credential-helper' as const, label: t('configAuthCredentialHelper') },
                    { value: 'https-token' as const, label: t('configAuthHttpsToken') },
                  ]).map(option => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={effectiveAuth === option.value}
                      disabled={busy}
                      onClick={() => {
                        props.onChange({ authMode: option.value })
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </FormRow>

              {tokenVisible ? (
                <>
                  <FormRow label={t('configTokenEnvVar')}>
                    <div className="dgs-inlineRow">
                      <TextInput
                        id="dgs-config-token-env"
                        value={form.tokenEnvVar}
                        placeholder="GITHUB_TOKEN"
                        disabled={busy}
                        onChange={value => {
                          props.onChange({ tokenEnvVar: value })
                        }}
                      />
                      {tokenState}
                    </div>
                    <span className="dgs-formRowHint">{t('configTokenEnvVarHint')}</span>
                  </FormRow>
                  <FormRow label={t('configUsername')}>
                    <TextInput
                      id="dgs-config-username"
                      value={form.username}
                      placeholder="git"
                      disabled={busy}
                      onChange={value => {
                        props.onChange({ username: value })
                      }}
                    />
                    <span className="dgs-formRowHint">{t('configUsernameHint')}</span>
                  </FormRow>
                </>
              ) : null}
            </>
          ) : null}

          <FormRow label={t('configDeviceName')}>
            <DeviceNameInput
              t={t}
              value={form.deviceName}
              options={props.deviceNames ?? []}
              disabled={busy}
              onChange={value => {
                props.onChange({ deviceName: value })
              }}
            />
            <span className="dgs-formRowHint">
              {(props.deviceNames ?? []).length === 0
                ? t('configDeviceEmptyHint')
                : t('configDeviceExistingHint')}
            </span>
          </FormRow>

          <FormRow label={t('configBackupDir')}>
            <TextInput
              id="dgs-config-backup-dir"
              value={form.backupDir}
              placeholder="dsh-plugins"
              disabled={busy}
              onChange={value => {
                props.onChange({ backupDir: value })
              }}
            />
            <span className="dgs-formRowHint">{t('configBackupDirHint')}</span>
          </FormRow>

          {form.repoUrl.trim() === '' || form.backupDir.trim() === '' ? null : (
            <FormRow label={t('configLocation')} className="dgs-repoLocationForm">
              <div className="dgs-repoLocation">
                <div className="dgs-repoLocationRow">
                  <span>{t('configLocationPlugins')}</span>
                  <code>{location.plugins}</code>
                </div>
                <div className="dgs-repoLocationRow">
                  <span>{t('configLocationSkills')}</span>
                  <code>{location.skills}</code>
                </div>
                <span className="dgs-formRowHint">{t('configLocationHint')}</span>
              </div>
            </FormRow>
          )}

          <div className="dgs-advanced">
            <button
              type="button"
              className="dgs-advancedToggle"
              aria-expanded={advancedOpen}
              aria-controls="dgs-config-advanced"
              onClick={() => {
                setAdvancedOpen(current => !current)
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
              <span>{t('configAdvanced')}</span>
            </button>
            <div id="dgs-config-advanced" className="dgs-formRows dgs-advancedBody" hidden={!advancedOpen}>
              <FormRow label={t('configBranch')}>
                <TextInput
                  id="dgs-config-branch"
                  value={form.branch}
                  placeholder="main"
                  disabled={busy}
                  onChange={value => {
                    props.onChange({ branch: value })
                  }}
                />
              </FormRow>
            </div>
          </div>

          <FormRow label={t('configClient')}>
            <div className="dgs-btnRow">
              <Badge tone="success">{clientLabel(t, view.activeProfile)}</Badge>
            </div>
            <span className="dgs-formRowHint">{t('configClientHint')}</span>
          </FormRow>
        </div>

        <div className="dgs-formActions">
          <Button variant="primary" onClick={props.onSave} disabled={busy || !dirty} loading={props.saving}>
            {props.saving ? t('saving') : t('save')}
          </Button>
        </div>

      </div>
    </Card>
  )
}

/** Plain-language name of the client the active profile belongs to. */
function clientLabel(t: Translate, profile: string): string {
  if (profile === 'desktop') return t('clientDesktop')
  if (profile === 'web') return t('clientWeb')
  return profile === '' ? t('notAvailable') : profile
}
