/**
 * Small presentation helpers shared by the sections: dates, commits, and
 * dictionary-backed labels for Host enum values.
 * @module format
 */

import type { Translate } from './i18n'
import type { PlanActionKind } from '../../src/types'

/** Render an ISO timestamp in the browser's locale; `fallback` when absent. */
export function formatDateTime(iso: string | null | undefined, fallback: string): string {
  if (iso === null || iso === undefined || iso === '') return fallback
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/** Compact byte size for small metadata rows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Short form of a Git commit for tables and badges. */
export function shortCommit(commit: string | null | undefined): string {
  if (commit === null || commit === undefined || commit === '') return ''
  return commit.slice(0, 8)
}

/**
 * Localized operation name for trailer values (`backup`, `restore`, ...).
 * A commit without trailers reports `unknown`: it was made outside the plugin,
 * so it is shown as an ordinary commit instead of a raw trailer value.
 */
export function operationLabel(t: Translate, operation: string): string {
  if (operation === 'unknown') return t('op_unknown')
  const key = `op_${operation}`
  const text = t(key)
  return text === key ? operation : text
}

/** Localized result label; anything unrecognized shows as-is. */
export function resultLabel(t: Translate, result: string | null | undefined): string {
  if (result === null || result === undefined || result === '') return t('unknown')
  const normalized = result.toLowerCase()
  if (normalized === 'ok' || normalized === 'success' || normalized === 'succeeded') return t('resultOk')
  if (normalized === 'migrated') return t('resultMigrated')
  if (normalized === 'no-changes' || normalized === 'no changes') return t('resultNoChanges')
  if (normalized === 'failed' || normalized === 'error' || normalized === 'failure') return t('resultFailed')
  return result
}

/** Whether a commit trailer result value means success. */
export function isGoodResult(result: string | null | undefined): boolean {
  if (result === null || result === undefined) return false
  const normalized = result.toLowerCase()
  return (
    normalized === 'ok' ||
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'migrated' ||
    normalized === 'no-changes' ||
    normalized === 'no changes'
  )
}

const SUBJECT_PREFIX = '[dsh-plugins-git-sync] '
const SUBJECT_OPERATIONS = ['skill-preferences', 'skill preferences', 'preferences', 'backup', 'restore', 'sync', 'rollback']

/** Replace the bilingual fragments older commits used with the short UI labels. */
function localizeSubjectDetail(t: Translate, detail: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/所有设备 \/ all devices|\bshared\b/gi, t('pluginScopePublicCheck')],
    [/仅本机 \/ this device only|\bprivate\b/gi, t('pluginScopePrivateCheck')],
    [/全部启用 \/ enabled everywhere|\benabled everywhere\b/gi, t('pluginPrefsEnabledAllOn')],
    [/全部停用 \/ disabled everywhere|\bdisabled everywhere\b/gi, t('pluginPrefsEnabledAllOff')],
    [/本机启用 \/ enabled here|\benabled here\b/gi, t('pluginPrefsEnableShort')],
    [/本机停用 \/ disabled here|\bdisabled here\b/gi, t('pluginPrefsDisableShort')],
  ]
  let result = detail
  for (const [pattern, label] of replacements) result = result.replace(pattern, label)
  return result
}

/**
 * Human-readable subject for a history row. Strips the plugin prefix, drops
 * the redundant operation/profile head, and localizes the old bilingual
 * "shared / private / enabled here" fragments. Commits the plugin did not
 * write keep their original subject.
 */
export function historySubject(t: Translate, entry: { operation: string; subject: string }): string {
  let subject = entry.subject.trim()
  if (subject.startsWith(SUBJECT_PREFIX)) subject = subject.slice(SUBJECT_PREFIX.length)
  if (entry.operation === 'unknown' || !SUBJECT_OPERATIONS.includes(entry.operation)) return subject
  let detail: string | null = null
  for (const operation of SUBJECT_OPERATIONS) {
    const prefix = `${operation} `
    if (!subject.startsWith(prefix)) continue
    const rest = subject.slice(prefix.length).trim()
    const profile = /^\S+/.exec(rest)?.[0] ?? ''
    let tail = rest.slice(profile.length).trim()
    if (tail.startsWith(':')) tail = tail.slice(1).trim()
    detail = localizeSubjectDetail(t, tail)
    break
  }
  return detail === null ? subject : detail
}

const PLAN_KIND_KEYS: Record<PlanActionKind, string> = {
  install: 'planKindInstall',
  upgrade: 'planKindUpgrade',
  downgrade: 'planKindDowngrade',
  enable: 'planKindEnable',
  disable: 'planKindDisable',
  'restore-config': 'planKindRestoreConfig',
  'remove-local': 'planKindRemoveLocal',
  'push-plugin': 'planKindPushPlugin',
  'push-config': 'planKindPushConfig',
  'remove-remote': 'planKindRemoveRemote',
}

/** Localized label for one plan step kind. */
export function planKindLabel(t: Translate, kind: PlanActionKind): string {
  return t(PLAN_KIND_KEYS[kind] ?? 'planKindInstall')
}
