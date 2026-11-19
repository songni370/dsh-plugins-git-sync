/**
 * `PluginInstaller` over the Host's plugin manager service.
 *
 * All install / remove / enable operations go through `ctx.pluginManager` —
 * the supported path that owns pnpm, profile files, activation and reload
 * semantics. This module never edits profile files and never shells out to a
 * package manager. A plugin's own source repository and the user's backup
 * repository stay separate: nothing here knows about the backup repository.
 * @module adapters/installer
 */

import type { DshBundleInfo, DshChangeResult, DshPluginInfo, DshPluginManager } from '../dsh.js'
import { SyncError, errorMessage } from '../core/errors.js'
import { redactText } from '../core/redact.js'
import type { InstallOutcome, PluginInstaller, SyncLogger, ToggleOutcome } from '../types.js'

/** Options for {@link createInstaller}. */
export interface InstallerOptions {
  /** The profile's plugin manager; absent on a composition without one. */
  pluginManager: DshPluginManager | undefined
  /** The profile this process runs in. Restores are limited to it. */
  activeProfile: string
  logger: SyncLogger
}

/** Normalize a plugin-manager change result into an install outcome. */
function toInstallOutcome(result: DshChangeResult, action: string): InstallOutcome {
  const failed = result.application === 'failed' || result.application === 'cancelled'
  const error = result.error === undefined ? undefined : redactText(`${result.error.code}: ${result.error.diagnostic ?? ''}`.trim())
  let message = `${action} ${result.target}: ${result.application}`
  if (result.application === 'restart-required') message = `${action} ${result.target}: 已安装，需要重启 DSH 后生效 / installed, restart DSH to activate`
  if (result.application === 'overridden') message = `${action} ${result.target}: 被更高优先级的配置覆盖 / overridden by a higher-priority layer`
  if (failed) message = `${action} ${result.target} 失败 / failed: ${error ?? 'unknown error'}`
  if (result.packageResult?.output !== undefined && failed) {
    const output = result.packageResult.output.trim()
    if (output !== '') message += `\n${redactText(output.slice(-1500))}`
  }
  return {
    ok: !failed,
    changed: result.changed,
    application: result.application,
    message,
    version: result.version,
    pendingBuilds: result.pendingBuilds,
    error: failed ? error : undefined,
    ...(result.application === 'restart-required' ? { pendingActivation: true } : {}),
  }
}

/** Normalize an enable/disable result. */
function toToggleOutcome(result: DshChangeResult, enabled: boolean): ToggleOutcome {
  const failed = result.application === 'failed' || result.application === 'cancelled'
  return {
    ok: !failed,
    changed: result.changed,
    application: result.application,
    message: failed
      ? `切换插件状态失败 / failed to ${enabled ? 'enable' : 'disable'}: ${redactText(result.error?.diagnostic ?? result.error?.code ?? 'unknown error')}`
      : `${enabled ? '已启用 / enabled' : '已禁用 / disabled'}`,
    error: failed ? redactText(result.error?.diagnostic ?? result.error?.code ?? 'unknown error') : undefined,
  }
}

/** Find a bundle row that names the module. */
function bundleForModule(bundles: readonly DshBundleInfo[], moduleName: string): DshBundleInfo | undefined {
  return bundles.find(bundle => bundle.name === moduleName || bundle.rows.some(row => row.moduleName === moduleName))
}

/** Read a stable error code from a plugin-manager failure. */
function errorCode(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  const message = errorMessage(error)
  return /already-installed/i.test(message) ? 'already-installed' : null
}

/** Strip a leading `v` so `v1.2.3` and `1.2.3` compare equal. */
function normalizeVersion(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null
  const trimmed = version.trim().replace(/^v/i, '')
  return trimmed === '' ? null : trimmed
}

/** Installed version reported by the plugin manager, or null when unknown. */
function installedVersionOf(bundle: DshBundleInfo | undefined): string | null {
  return bundle === undefined ? null : normalizeVersion(bundle.version ?? bundle.installTarget?.version ?? null)
}

/** Spec that reinstalls the currently installed version, when one can be derived. */
function restoreSpecFor(bundle: DshBundleInfo, installedVersion: string | null): string | null {
  const spec = bundle.installTarget?.spec?.trim()
  if (spec !== undefined && spec !== '') return spec
  return installedVersion === null ? null : `${bundle.name}@${installedVersion}`
}

/** Package name from an npm-style spec, used when the caller did not provide one. */
function packageNameFromSpec(spec: string): string | null {
  const value = spec.trim()
  if (value === '' || /^(?:git|file|link|workspace|github|gitlab|bitbucket):/i.test(value)) return null
  if (/^(?:https?|ssh|git\+https|git\+ssh):\/\//i.test(value)) return null
  const at = value.lastIndexOf('@')
  if (at > 0) return value.slice(0, at)
  return /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : null
}

/** Create the installer. */
export function createInstaller(options: InstallerOptions): PluginInstaller {
  const requireManager = (): DshPluginManager => {
    const manager = options.pluginManager
    if (manager === undefined || typeof manager.installBundle !== 'function') {
      throw new SyncError(
        'unsupported',
        '当前 DSH 环境不提供插件管理服务，无法安装或移除插件 / the DSH plugin manager service is unavailable',
      )
    }
    return manager
  }

  const requireActiveProfile = (profile: string): void => {
    if (profile !== options.activeProfile) {
      throw new SyncError(
        'unsupported',
        `只能修改当前 Profile（${options.activeProfile}）的插件；请切换到 ${profile} 后重试 / only the active profile can be modified`,
      )
    }
  }

  return {
    async install(spec, request): Promise<InstallOutcome> {
      const manager = requireManager()
      requireActiveProfile(request.profile)
      const value = spec.trim()
      if (value === '') throw new SyncError('install-failed', '安装规格为空 / empty install spec')

      /** Read the bundle that provides a module name. */
      const readBundle = async (name: string): Promise<DshBundleInfo | undefined> => {
        const bundles = await manager.listBundles()
        return bundles.find(item => item.name === name || item.rows.some(row => row.moduleName === name))
      }

      /** Check that a bundle is installed at exactly `targetVersion`. */
      const verifyVersion = async (name: string, targetVersion: string): Promise<{ ok: boolean; version: string | null }> => {
        try {
          const version = installedVersionOf(await readBundle(name))
          return { ok: version === targetVersion, version }
        } catch {
          return { ok: false, version: null }
        }
      }

      /** Put the previous version back after a failed upgrade; returns a human-readable note. */
      const restorePrevious = async (bundle: DshBundleInfo, installedVersion: string | null): Promise<string> => {
        const spec = restoreSpecFor(bundle, installedVersion)
        if (spec === null) {
          return `无法自动恢复旧版（${bundle.name} 没有可用的安装来源），请手动重装 / cannot restore automatically`
        }
        try {
          const result = await manager.installBundle(spec, { saveExact: true, enabled: true })
          if (result.application === 'failed' || result.application === 'cancelled') {
            const reason = redactText(result.error?.code ?? result.error?.diagnostic ?? 'unknown error')
            return `旧版恢复失败 / could not restore ${bundle.name}: ${reason}；请手动安装 ${spec}`
          }
          return `已恢复旧版 / restored ${bundle.name}（${installedVersion ?? '版本未知'}）`
        } catch (error) {
          return `旧版恢复失败 / could not restore ${bundle.name}: ${redactText(errorMessage(error))}；请手动安装 ${spec}`
        }
      }

      /** Resolve an `already-installed` refusal: same version is a no-op, a different version is replaced atomically. */
      const resolveAlreadyInstalled = async (): Promise<InstallOutcome> => {
        const targetName = request.name?.trim() || packageNameFromSpec(value)
        const bundle = targetName === null ? undefined : await readBundle(targetName)
        if (bundle === undefined) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `插件 ${targetName ?? value} 已安装，但无法读取版本；请在插件管理器中手动检查 / already installed but its version is unknown`,
            error: 'already-installed',
          }
        }
        const installedVersion = installedVersionOf(bundle)
        const targetVersion = normalizeVersion(request.version ?? null)
        if (targetVersion === null) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `${bundle.name} 已安装${installedVersion === null ? '' : `（${installedVersion}）`}，但无法确认目标版本；请在插件管理器中手动更新 / installed but the target version is unknown`,
            error: 'already-installed',
          }
        }
        if (installedVersion === null) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `${bundle.name} 已安装，但无法读取当前版本，无法安全升级到 ${targetVersion}；请手动更新 / installed version is unknown`,
            error: 'already-installed',
          }
        }
        if (installedVersion === targetVersion) {
          return {
            ok: true,
            changed: false,
            application: 'applied',
            message: `${bundle.name} 已安装（${installedVersion}），无需重复安装 / already installed`,
            version: installedVersion,
          }
        }
        if (!bundle.removable) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `${bundle.name} 已安装 ${installedVersion}，无法自动升级到 ${targetVersion}；请手动更新 / cannot replace automatically`,
            error: 'already-installed',
          }
        }
        options.logger.info(
          `替换插件版本 / replacing plugin version: ${bundle.name} ${installedVersion} -> ${targetVersion}`,
        )
        const removal = await manager.removeBundle(bundle.name)
        if (removal.application === 'failed' || removal.application === 'cancelled') {
          const reason = redactText(removal.error?.diagnostic ?? removal.error?.code ?? 'unknown error')
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `升级 ${bundle.name} 失败：无法移除旧版本 / could not remove ${installedVersion}: ${reason}`,
            error: reason,
          }
        }
        const result = await manager.installBundle(value, { saveExact: true, enabled: true })
        const outcome = toInstallOutcome(result, '升级 / upgrade')
        if (outcome.ok && outcome.application === 'applied') {
          const verification = await verifyVersion(bundle.name, targetVersion)
          if (!verification.ok) {
            const restored = await restorePrevious(bundle, installedVersion)
            return {
              ok: false,
              changed: true,
              application: 'failed',
              message: `升级 ${bundle.name} 到 ${targetVersion} 后版本校验失败（实际 ${verification.version ?? '未知'}）；${restored}`,
              error: 'version-mismatch',
            }
          }
        }
        if (outcome.ok) {
          outcome.message = `${bundle.name} ${installedVersion} → ${targetVersion}，${outcome.message}`
          return outcome
        }
        const restored = await restorePrevious(bundle, installedVersion)
        return {
          ok: false,
          changed: outcome.changed,
          application: outcome.application,
          message: `升级 ${bundle.name} 到 ${targetVersion} 失败：${outcome.message}\n${restored}`,
          error: outcome.error ?? 'upgrade-failed',
        }
      }

      options.logger.info(`安装插件 / installing plugin: ${value}`)
      try {
        const result = await manager.installBundle(value, { saveExact: true, enabled: true })
        if (result.application === 'failed' && result.error?.code === 'already-installed') {
          return await resolveAlreadyInstalled()
        }
        const outcome = toInstallOutcome(result, '安装 / install')
        if (outcome.pendingBuilds !== undefined && outcome.pendingBuilds.length > 0) {
          outcome.message += `\n需要在插件管理器中批准构建脚本 / build scripts need approval: ${outcome.pendingBuilds.join(', ')}`
        }
        if (outcome.ok && outcome.application === 'applied') {
          const targetName = request.name?.trim() || packageNameFromSpec(value)
          const targetVersion = normalizeVersion(request.version ?? null)
          if (targetName !== null && targetVersion !== null) {
            const verification = await verifyVersion(targetName, targetVersion)
            if (!verification.ok) {
              return {
                ok: false,
                changed: outcome.changed,
                application: 'failed',
                message: `安装 ${value} 后版本校验失败（实际 ${verification.version ?? '未知'}，期望 ${targetVersion}）/ installed version mismatch`,
                error: 'version-mismatch',
                version: verification.version ?? undefined,
              }
            }
          }
        }
        return outcome
      } catch (error) {
        if (errorCode(error) === 'already-installed') {
          try {
            return await resolveAlreadyInstalled()
          } catch (replacementError) {
            const message = redactText(errorMessage(replacementError))
            return {
              ok: false,
              changed: false,
              application: 'failed',
              message: `升级 ${value} 失败 / failed to replace: ${message}`,
              error: message,
            }
          }
        }
        return {
          ok: false,
          changed: false,
          application: 'failed',
          message: `安装 ${value} 失败 / failed to install: ${redactText(errorMessage(error))}`,
          error: redactText(errorMessage(error)),
        }
      }
    },

    async setEnabled(moduleName, enabled, request): Promise<ToggleOutcome> {
      const manager = requireManager()
      requireActiveProfile(request.profile)
      try {
        const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
        const bundle = bundleForModule(bundles, moduleName)
        if (bundle !== undefined) {
          if (bundle.enabled === enabled) {
            return { ok: true, changed: false, application: 'applied', message: '状态已一致 / already in the requested state' }
          }
          const result = await manager.setBundleEnabled(bundle.name, enabled)
          return toToggleOutcome(result, enabled)
        }
        const entry = plugins.find(plugin => plugin.moduleName === moduleName)
        if (entry === undefined) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `找不到已安装的插件 ${moduleName} / plugin is not installed`,
            error: 'not installed',
          }
        }
        if (entry.enabled === enabled) {
          return { ok: true, changed: false, application: 'applied', message: '状态已一致 / already in the requested state' }
        }
        const result = await manager.setPluginEnabled(entry.entryId, enabled)
        return toToggleOutcome(result, enabled)
      } catch (error) {
        return {
          ok: false,
          changed: false,
          application: 'failed',
          message: `切换 ${moduleName} 状态失败 / failed to toggle: ${redactText(errorMessage(error))}`,
          error: redactText(errorMessage(error)),
        }
      }
    },

    async remove(moduleName, request): Promise<InstallOutcome> {
      const manager = requireManager()
      requireActiveProfile(request.profile)
      try {
        const bundles = await manager.listBundles()
        const bundle = bundles.find(item => item.name === moduleName)
        if (bundle === undefined) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `${moduleName} 不是可移除的插件包 / not a removable bundle`,
            error: 'not a bundle',
          }
        }
        if (!bundle.removable) {
          return {
            ok: false,
            changed: false,
            application: 'failed',
            message: `${moduleName} 不可自动移除 / bundle cannot be removed automatically`,
            error: bundle.readOnlyReason ?? 'not removable',
          }
        }
        options.logger.warn(`移除插件 / removing plugin: ${moduleName}`)
        const result = await manager.removeBundle(moduleName)
        return toInstallOutcome(result, '移除 / remove')
      } catch (error) {
        return {
          ok: false,
          changed: false,
          application: 'failed',
          message: `移除 ${moduleName} 失败 / failed to remove: ${redactText(errorMessage(error))}`,
          error: redactText(errorMessage(error)),
        }
      }
    },

    async latestVersion(moduleName, signal): Promise<string | null> {
      const manager = options.pluginManager
      if (manager === undefined || typeof manager.inspect !== 'function') return null
      try {
        const inspection = await manager.inspect(moduleName, undefined, signal)
        if (inspection.status !== 'accepted') return null
        return inspection.version ?? null
      } catch {
        return null
      }
    },
  }
}

/** List the plugins currently installed in the active profile. */
export async function listInstalledPlugins(manager: DshPluginManager | undefined): Promise<DshPluginInfo[]> {
  if (manager === undefined) return []
  try {
    return await manager.listPlugins()
  } catch {
    return []
  }
}
