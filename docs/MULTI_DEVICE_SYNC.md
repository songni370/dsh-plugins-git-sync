# 多设备同步设计（v0.3.0）

- 状态：已在 0.3.0 实现（本文保留设计依据与规则表；实现细节见 [ARCHITECTURE.md](ARCHITECTURE.md) 3.6、5.2 与 `services/repo-v2.ts`）
- 目标版本：0.3.0（发版只在你明确说「发版」时进行）
- 基线版本：0.2.13
- 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)、[PUBLISHING.md](PUBLISHING.md)
- 证据来源：A/B 两台 Mac 的真实仓库 `dsh-plugin-backup`（34 个提交）、A 机 `sync.log`、B 机只读诊断报告（2026-11-19）

---

## 0. 摘要

当前实现（0.2.x）本质上是「单机备份 + 一个三方合并原型」：

1. 仓库里只有一份全局插件清单（`profiles/<profile>/plugins.json`），没有「哪台设备想要什么」的信息，最后写入者覆盖全局状态。
2. 删除/版本语义不完整：tombstone 会被其他设备复活；push 不比较新旧；降级不拦；备份可能把新版本覆盖成旧版本。
3. 安装不可靠且不可见：宿主拒绝安装被当成可忽略的 warning；`already-installed` 在版本未知时静默成功；升级采用「先卸载旧版、再装新版」，失败时旧版不恢复；失败发生在写仓库之前，所以仓库里看不到失败。

v0.3.0 改为 **以设备为单位的期望状态（per-device desired state）+ 策略（policy）+ 协调器（reconciler）**：

- 每台设备在仓库里写自己的 `devices/<id>/<profile>.json`（想要什么、删了什么、同步状态）。
- 全局 `policies/<profile>.json` 定义默认行为：一致性、删除传播、版本跟踪、降级确认、DSH 最低版本。
- 同步是幂等的「收敛」：读到仓库期望 → 与本机实际状态 diff → 预检 → 确认破坏性动作 → 快照 → 原子执行并校验 → 写回本设备状态。
- v1 仓库可无痛迁移到 v2；新插件读 v1 自动迁移，旧插件遇到 v2 明确报错而不是误写。

---

## 1. 已确认的决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 多设备目标 | 默认全设备一致；插件可按设备限定（scope） |
| 2 | 删除语义 | 传播删除；设备专属插件除外 |
| 3 | 版本策略 | 自动升级到最新；降级必须确认 |
| 4 | 迁移 | v1 仓库无痛迁移；v1 保持只读兼容 |
| 5 | 版本号 | 0.3.0 |
| 6 | DSH 兼容 | 只支持 DSH >= 0.2.2 |
| 7 | 「备份」按钮 | 保留；检测到多设备时警告并建议改用「同步」 |
| 8 | 启用/禁用 | 默认全局；设备可用显式 override 覆盖 |
| 9 | 旧版 DSH 设备 | 跳过不兼容插件并标记 blocked，其余插件照常 |
| 10 | includeConfigs | 彻底移除（插件配置不备份） |
| 11 | 多 profile | 0.3.0 仍只支持单 profile |
| 12 | 备份与删除 | 只在明确本机删除时写删除意图 |
| 13 | 发布节奏 | 不单独发 0.2.14；热修内容并入 0.3.0，优先完成 |

---

## 2. 事故复盘：B 机为什么「不能安装新版本」

### 2.1 时间线（B 机本地时间）

| 时间 | 事件 |
|---|---|
| 11-16 15:14 | A 机把 `dsh-better-sidebar` 升到 `0.32.1` 并推送（`7332a1e`）。该版本要求 `@deepseek-ai/* ^0.2.2-rc.2` |
| 11-18 20:50 / 20:51 | B 机两次 restore 批量升级，回滚 `notRestorable:0` |
| 11-18 20:53:28 | B 机 restore：先 `- dsh-better-sidebar 0.30.1`（卸载）→ 安装 `0.32.1`，被宿主拒绝：`incompatible-version`（B 运行时 `0.2.2-rc.1`） |
| 11-18 20:53:51 | 回滚 `notRestorable:1` —— 旧版 0.30.1 **没有装回**，B 从此没有 better-sidebar |
| 11-18 20:56:37 | B 机 sync 把「没有 better-sidebar」写成 `972cf0c`（Plugin-Count 7） |
| 11-18 20:57:39 | B 再次 restore 安装 0.32.1，再次被拒，回滚 `notRestorable:0` |
| 11-19 10:55 | B 升级到 DSH `0.2.2-rc.5`（满足 `^0.2.2-rc.2`），但尚未重试安装 |

### 2.2 根因分层

| 层 | 问题 | 性质 |
|---|---|---|
| 宿主 | DSH 在 pnpm 之前做版本门禁，`rc.1` 不满足 `^0.2.2-rc.2` | **宿主行为正确**；升级 DSH 后已消失 |
| 插件安装 | 升级 = 先卸载旧版 → 装新版；新版被拒后旧版不恢复；回滚只恢复配置，不恢复插件 | **数据丢失级 bug，必须修** |
| 插件冲突 | `local-deleted` 冲突阻塞整个 sync；`state.conflicts` 不持久化；autoSync 关闭后无人推进；`lastError` 永久停留 | 设计 bug |
| 插件配置 | B 磁盘 `config.json` 是旧结构（`includeConfigs: true`、`intervalMinutes: 30`），运行时归一化为新结构但不回写 | 迁移缺陷 |
| 只读预览 | `dsh_git_plugin_diff` 会 `fetch + reset --hard + checkout -B`，读操作会移动工作区 | 行为需明示/改进 |
| 多设备模型 | 缺少设备维度：B 的「缺失」被 A 视为可复活；A 的本地状态能覆盖更新的远端；删除/版本无策略 | **本次重构要解决** |

### 2.3 直接结论

- **B「不能安装新版本」的直接原因是 DSH 运行时版本门禁**（rc.1 vs 要求 rc.2+），不是网络/SSH/registry；现在 B 已是 rc.5，条件已满足。
- **B「同步各种不对」的直接原因是 `local-deleted` 冲突 + autoSync 关闭**，冲突不持久化，页面看不到完整原因。
- **最严重的产品缺陷是升级失败导致插件丢失且无法恢复**（`notRestorable:1`），这必须在 0.3.0 之前修掉，否则任何用户升级不兼容版本都会丢插件。

---

## 3. v2 仓库模型

### 3.1 目录布局

```text
manifest.json                     # schemaVersion 2；设备列表；生成器版本
policies/<profile>.json           # 全局策略（默认行为）
devices/<deviceId>/<profile>.json # 每台设备的期望状态 + 自己的同步状态
profiles/<profile>/plugins.json   # v1 兼容镜像（派生、只读给旧版本）
profiles/<profile>/skills/<name>/…# 技能文件（内容不变）
metadata/schema.json              # 仓库格式说明
```

### 3.2 `manifest.json`

```json
{
  "schemaVersion": 2,
  "generator": { "name": "dsh-plugins-git-sync", "version": "0.3.0" },
  "migratedFrom": 1,
  "profiles": { "desktop": { "pluginCount": 7 } },
  "devices": [
    { "id": "dev-950dbd8e17ab1d0b", "name": "Mac-mini.company", "platform": "darwin",
      "arch": "arm64", "dshVersion": "0.2.2-rc.5", "pluginVersion": "0.3.0",
      "lastSyncAt": "2026-11-19T02:23:06.272Z", "lastCommit": "b77049e…" }
  ],
  "updatedAt": "2026-11-19T02:23:06.272Z"
}
```

### 3.3 `policies/<profile>.json`

```json
{
  "schemaVersion": 2,
  "profile": "desktop",
  "sync": {
    "mode": "two-way",
    "auto": { "enabled": true, "apply": "safe", "onStartup": true, "onPluginChange": true }
  },
  "deletion": { "propagate": true },
  "versions": { "default": "track", "downgrade": "confirm", "allowPrerelease": false },
  "scope": { "default": "all" },
  "minDshVersion": "0.2.2",
  "backupButton": { "warnWhenMultiDevice": true }
}
```

- `sync.auto.apply = safe`：自动只执行安装/升级/启用，不自动卸载、不自动降级；卸载/降级进入待确认队列。
- 与旧 `autoSync.mode = backup` 的对应关系：备份模式只写本设备期望状态，不安装任何东西。

### 3.4 `devices/<deviceId>/<profile>.json`

```json
{
  "schemaVersion": 2,
  "device": { "id": "dev-…", "name": "Mac-mini.home", "platform": "darwin", "arch": "arm64" },
  "profile": "desktop",
  "updatedAt": "2026-11-19T…",
  "baseCommit": "…",
  "plugins": {
    "dsh-better-sidebar": {
      "version": "0.32.1",
      "enabled": true,
      "installSpec": "dsh-better-sidebar@0.32.1",
      "origin": "npm",
      "syncable": true,
      "scope": { "mode": "all" },
      "versionPolicy": "track"
    },
    "dsh-vps-manager": {
      "version": "0.6.10",
      "enabled": true,
      "installSpec": "dsh-vps-manager@0.6.10",
      "scope": { "mode": "devices", "devices": ["dev-950dbd8e17ab1d0b"] },
      "versionPolicy": "pin",
      "pinnedVersion": "0.6.10"
    }
  },
  "removed": [ { "id": "dsh-context", "at": "2026-11-18T09:38:19Z" } ],
  "skills": { "cloudflare": { "hash": "sha256:…" }, "ponytail": { "hash": "sha256:…", "deleted": false } },
  "status": {
    "lastSyncAt": "2026-11-19T…",
    "lastResult": "conflict",
    "lastError": null,
    "pendingActivation": [ { "pluginId": "dsh-better-sidebar", "version": "0.32.1", "reason": "restart-required" } ]
  }
}
```

关键点：

- **期望状态按设备分开**：B 不再需要把「本机没有」解释成「全局删除」。
- **`removed` 是显式删除意图**，不是「本机恰好没有」。由失败导致的缺失绝不能写进 `removed`。
- **`scope`** 支持 `all` 或指定设备列表；`versionPolicy` 支持 `track` / `pin`。
- **`status`** 让失败、待重启、待确认在多设备间可见；旧仓库看不到失败的问题一并解决。
- 设备快照里仍保留完整 inventory（便于诊断），但只作为「观测记录」，不参与决策。

### 3.5 技能

- 技能文件仍按目录存放（可读、可 diff）。
- 设备清单记录每个技能的**文件哈希**；同步时按文件做三方比较：
  - 仅远端有 → 安装；
  - 仅本机有 → 上传；
  - 两边都有且哈希不同 → 冲突（按文件选择，不整目录覆盖）；
  - 删除：与插件同一套 `removed` + 策略；本地删除不再被远端静默恢复。

---

## 4. 同步算法（reconciler）

### 4.1 输入

1. 本机实际 inventory（scanner）
2. 仓库：`policies`、所有设备清单、自己的清单、v1 镜像（只读）
3. 本机 baseline（上次成功应用到的 commit + 每个插件的已确认版本/启用状态）
4. 运行环境：DSH 版本、平台、arch、当前 profile

### 4.2 计算期望状态（desired）

按插件 id 聚合所有「适用于本机」的设备条目（`scope.mode == all` 或设备列表包含本机）：

| 情形 | 结果 |
|---|---|
| 只有一个设备声明 | 采用该声明 |
| 多个设备声明相同版本/启用状态 | 合并 |
| 多个 `track` 声明不同版本 | 取其中最高版本（semver，遵守 DSH 兼容） |
| 存在 `pin` | pin 优先；同一插件多个不同 pin → 冲突 |
| 某设备 `removed` 且 `deletion.propagate` | 期望为「不存在」；本机若存在 → 卸载（需确认） |
| `deletion.propagate = false` | 不因其他设备删除而卸载本机；也不把本机副本推回仓库（**不复活**） |
| 版本低于本机（降级） | 标记为需确认，不自动执行 |
| 远端版本与 DSH 不兼容 | 跳过并记录 `blocked`，不影响其他插件 |

### 4.3 生成动作

- `install / upgrade / downgrade / enable / disable / remove`
- `push-plugin`（仅当本机有、期望有、且本机版本/启用状态与期望不同）
- `push-removal`（仅当本机 `removed` 是显式删除，且策略允许）
- `apply-skill / remove-skill`（按文件哈希）
- 不再有「远端没有 → 补回仓库」这种隐式复活；只有用户显式恢复（restore）才重新添加。

### 4.4 冲突矩阵（v2）

| 本机 | 仓库期望 | 结果 |
|---|---|---|
| 有，版本相同 | 有 | 无动作 |
| 有，版本较旧 | 有较新 | 自动升级（若兼容、不降级） |
| 有较新 | 有较旧 | 降级 → 待确认 |
| 有 | 无（显式删除且传播） | 卸载 → 待确认（`apply: safe` 时不自动执行） |
| 有 | 无（从未声明） | 视为本机新增 → 候选上传 |
| 无 | 有（安装） | 安装；不可安装 → `blocked` 并记录原因 |
| 无 | 有（pin 冲突 / 多声明不一致） | 冲突 → 待处理 |
| 本机显式删除 | 远端仍声明有 | 删除传播 vs 保留 → 按策略/确认 |
| 本机未删除，仅是失败后缺失 | 远端有 | **重新安装，不写删除** |

### 4.5 执行顺序

```text
fetch → read repo(v2) → migrate(v1→v2, 首次)
  → desired = merge(policy, devices, local scope)
  → preflight(所有动作)        # 任何不可行动作在执行前暴露
  → 确认破坏性动作
  → snapshot(本机 inventory + configs)
  → execute actions（每个动作独立校验）
  → verify(local inventory vs desired)
  → 写自己的设备清单 + status
  → commit（trailer: 设备、profile、结果、动作数）
  → baseline 前进到新 commit（即使只有 push 也前进）
  → 失败也写 status（lastError / lastResult），并 commit
```

失败可见：任何失败都必须写 `devices/<id>/<profile>.json` 的 `status` 并提交，除非推送本身失败（此时本机状态文件仍更新，下次同步再推）。

### 4.6 并发

- 保持「不 force push」：非快进 → fetch → 重新计算 → 重试。
- 重试时重新读远端，重新计算 desired，不盲目重放旧动作。
- 检测到自己上次失败的 commit 被其他设备覆盖时，以远端为准并记录 warning。

---

## 5. 删除、复活与「备份」语义

### 5.1 删除

- 用户卸载插件后，本机清单写 `removed: [{id, at}]`。
- 策略 `deletion.propagate = true`：其他设备同步时卸载并记录（安全模式下先确认，确认后可记住选择）。
- 设备专属插件（`scope.mode = devices`）只影响范围内的设备，范围外设备视为不存在。
- 任何情况下都不允许「本机没有 → 自动推回仓库」；只有 restore/显式恢复才重新添加。

### 5.2 失败导致的缺失

- 执行前记录 inventory；执行后若某插件既没有对应动作、又不在 `removed` 中却消失了 → 判为异常，不写删除，保留在期望状态里，下次重装。
- 这是 B 事故（升级失败 → 插件消失 → sync 把缺失当删除提交）的直接防线。

### 5.3 「备份」按钮

- 保留原语义：把本机状态写入仓库，不安装、不更新其他设备。
- 仓库里存在 ≥2 台设备时，点击备份先警告：
  > 「备份只上传本机状态，不会安装或更新其他设备。多设备建议使用「同步」。」
- 备份不自动把「本机缺少、但本机从未安装过」的插件写成删除；只有明确的本机 `removed` 才写删除。

---

## 6. 版本策略

- `track`：跟随仓库中最高兼容版本；默认值。
- `pin`：锁定版本，只对声明它的设备生效；其他设备仍可 track。
- 预览版（`-rc`/`-beta`）默认不自动采用；需策略显式允许或手动指定。
- 降级一律需确认（策略 `versions.downgrade = confirm`）。
- 兼容性预检：
  - 读取插件包 `engines` / peer 依赖（若可获取），对比本机 DSH 版本；
  - 不兼容 → 不执行，记录 `blocked` + 可操作提示（升级 DSH / 换版本 / 设备豁免）；
  - 绝不把宿主拒绝当成成功。

---

## 7. 安装管线

### 7.1 预检（执行前，全部动作一起）

- 目标 spec 可解析（`installSpec` 非空，或 npm + version）。
- 本机 DSH 版本满足要求。
- bundle 是否 removable（不可替换的插件提前报错）。
- 是否有 pendingBuilds 需要确认。
- profile 是否是当前活动 profile。
- 磁盘/权限/SSH（轻量）。

### 7.2 原子升级（修复 `notRestorable`）

当前实现是「卸载旧版 → 安装新版」，第二步失败后旧版丢失。改为：

```text
oldSpec = 当前版本的 installSpec（必须可解析）
snapshot(inventory + configs)
if 未安装: install(target)
else if 版本相同: 只处理 enabled
else:
  remove(current)
  install(target)
  if install 失败:
    尝试 reinstall(oldSpec) 并 verify
    if 恢复失败: 标记 failed，保留快照，输出可操作错误（含旧版本 spec）
verify: 重新扫描，比较 version/enabled
if restart-required/overridden: 标记 pendingActivation，不算成功完成
```

- 对 `already-installed`：先比较实际安装版本；版本未知时**不再静默成功**，而是按「无法确认」失败并提示手动处理。
- 对不可替换 bundle：提前失败，附原因。
- 恢复旧版本也失败时，错误信息必须包含旧版 spec 和手动安装命令。

### 7.3 执行后校验

- 每个 local action 记录 `ActionOutcome{ok, changed, installedVersion?, error?}`。
- 校验：实际版本 == 目标版本、enabled == 目标；不满足 → 操作失败。
- `setEnabled` 失败也必须暴露，不能吞掉。
- 重启后再次校验 `pendingActivation`，通过后清除并写状态。

### 7.4 回滚

- 快照保存 inventory + configs + 已安装版本。
- 失败时按动作逆序回滚：恢复版本、恢复 enabled、恢复配置；不再只恢复配置。
- 回滚结果写 `status` 与日志；回滚失败要显式告警「可能需要手动恢复」。

---

## 8. 状态与迁移

### 8.1 本机状态 v2

```json
{
  "schemaVersion": 2,
  "device": { "id": "…", "name": "…", "platform": "darwin", "arch": "arm64",
              "dshVersion": "0.2.2-rc.5", "pluginVersion": "0.3.0" },
  "configVersion": 2,
  "lastSyncAt": "…",
  "lastCommit": "…",
  "baselines": { "desktop": { "commit": "…", "plugins": { "id": { "version": "…", "enabled": true } } } },
  "conflicts": [ { "pluginId": "…", "reason": "…", "local": "…", "remote": "…" } ],
  "pendingActivation": [ { "pluginId": "…", "version": "…", "at": "…" } ],
  "autoSyncFailures": 0,
  "lastError": null,
  "lastOperation": { "operation": "sync", "ok": true, "at": "…", "changedPlugins": 0 }
}
```

- `conflicts` 必须持久化（修复 B 机「页面 0 冲突、预检 1 冲突」）。
- `pendingActivation` 持久化，重启后校验。
- 配置归一化后**写回** `config.json`（修复旧结构漂移）。

### 8.2 本机配置 v2

- 增加 `schemaVersion`；旧字段 `includeConfigs`、`autoSync.intervalMinutes` 读取时归一化并写回（前者按「配置永不备份」处理，后者归零）。
- 新增 `policyOverrides`（本机对策略的覆盖）、`scopeDefaults`。

### 8.3 仓库 v1 → v2 迁移

1. 读 `manifest.json`（`schemaVersion: 1`）。
2. 生成 `policies/<profile>.json`：默认 `two-way`、`deletion.propagate=true`、`versions.default=track`、`downgrade=confirm`、`minDshVersion=0.2.2`、`auto.apply=safe`。
3. 用现有 `devices/<id>/<profile>.json` 生成 v2 设备清单：active inventory → `plugins`；v1 全局 tombstone → 每个设备条目上的 `removed`（或者放在一个 `legacy` 设备的 `removed`，由策略解释；推荐按设备已安装情况推断，无法推断时保守处理为「不传播」）。
4. 保留 `profiles/<profile>/plugins.json` 作为 v1 兼容镜像（每次提交时同步更新），`metadata/schema.json` 标记 `schemaVersion: 2`。
5. 一次提交 `migrate: v1 → v2`，trailer 标记 `Result: migrated`；迁移前的 HEAD 打 tag（如 `pre-v2-migration`）便于回滚。
6. 幂等：已 v2 直接跳过；迁移失败不写任何文件（在内存构建后一次性 commit）。
7. 新插件读 v1：自动迁移；旧插件读 v2：检测 `schemaVersion > 1` 直接报错「仓库由更新版本创建，请先升级插件」，禁止写入。

---

## 9. 兼容性与 API

- 只支持 DSH >= 0.2.2；启动时检测，低于则禁用功能并给出明确提示。
- 保持现有 15 个 Web 路由名和 6 个 agent 工具名不变；新增能力用**追加字段/新增路由**实现：
  - `status` 增加 `devices`、`pendingActivation`、`policy`、`repoSchemaVersion`；
  - 新增 `devices/list`、`policies/save`、`activation/verify` 等（命名沿用现有风格）。
- 客户端 bundle 仍禁止从 `@deepseek-ai/*` 引入运行时值（只允许类型/结构）。
- 仓库格式版本守卫：`schemaVersion > 2` 拒绝写入；`schemaVersion == 1` 只读 + 自动迁移。

---

## 10. UI/UX

- **备份按钮**：多设备时先弹确认/警告，文案说明只上传不安装，提供「改用同步」。
- **状态页**：设备列表（名称、DSH 版本、最后同步、待同步数、状态）；自己的 `blocked`/`conflict`/`pendingActivation` 置顶。
- **冲突处理**：展示双方版本、来源设备、时间；解释后果必须准确（删除是否传播、下次同步会发生什么）；支持「仅本设备」与「记住选择」。
- **待重启**：显示 `pendingActivation`，重启后自动校验并清除。
- **自动同步**：安全模式（不自动卸载/降级）、暂停原因持久化、可一键恢复；不再出现「冲突永远卡住且页面不说原因」。
- **错误**：`lastError` 在成功操作后清除（0.2.12 已修）；失败详情写 repo `status`，多设备可见。

---

## 11. 分阶段实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 | 测试地基：fake DSH 支持 `already-installed`/`removable`/`application`/`pendingBuilds`；v1 仓库 fixture；迁移测试 | 可信的失败注入能力 |
| 1 | v2 schema + 策略 + 设备清单 + v1→v2 迁移 + 状态可见性 | 仓库可读写两种格式 |
| 2 | reconciler：desired/scope/删除/版本策略/冲突持久化 | 多设备语义正确 |
| 3 | 安装管线硬化：预检、原子升级、校验、回滚、待激活 | 不再丢插件/假成功 |
| 4 | 技能哈希与冲突、删除传播 | 技能同步正确 |
| 5 | UI/UX、文档、0.3.0 发布 | 可见、可控 |

安全修复（原 0.2.14 热修内容）并入 0.3.0，且优先于 v2 模型落地：原子升级失败恢复旧版、安装后校验、冲突持久化、配置归一化、失败导致的缺失不写删除。这些改动不依赖仓库格式，先做先安全。

---

## 12. 测试矩阵

| 类别 | 用例 |
|---|---|
| 规划器 | 四种三方状态组合 × 删除/版本/scope/pin；不再出现复活 |
| 迁移 | v1 fixture → v2；幂等；失败不落盘；旧版本读 v2 报错 |
| 双设备集成 | A 升级、B 拉取；B 删除传播到 A；设备专属插件不扩散；并发 push 重试；失败后重试 |
| 安装 | already-installed（版本已知/未知）；不可替换；pendingBuilds；restart-required/overridden；升级失败恢复旧版；setEnabled 失败 |
| 冲突 | 冲突持久化；安全模式不自动卸载；确认后推进；不再「下次还提示」 |
| 技能 | 仅远端、仅本机、双改冲突、删除传播、大文件 |
| 客户端 | 备份按钮多设备警告；设备列表；pendingActivation；冲突文案 |
| 回归 | 现有 34 个测试文件、316 个测试保持通过；15 路由/6 工具名不变 |

---

## 13. 验收标准

1. 复现 B 场景：运行时 rc.1 安装 0.32.1 被拒 → 自动恢复 0.30.1，错误明确；升级到 rc.5 后重试 → 安装成功并校验版本。
2. 任一设备升级失败，本机插件不会消失；回滚后版本、enabled、配置都恢复。
3. A 删除插件 → 其他设备同步后卸载（或按策略确认），不再被复活。
4. 设备专属插件只在指定设备出现，其他设备既不安装也不上传。
5. 失败可见：仓库 `devices/<id>/status.json` 与页面都能看到原因；成功操作后 `lastError` 清除。
6. v1 仓库迁移无数据丢失；迁移前有 tag 可回滚；旧插件读 v2 明确报错。
7. 0.3.0 通过 `npm run verify`、双设备手工验证、公开文档更新。

---

## 14. 已确认的补充决策（2026-11-19）

1. `enabled`：默认全局，设备可用显式 override 覆盖（LWW 只作为无 override 时的回退）。
2. 旧版 DSH 设备：跳过不兼容插件并标记 `blocked`，其余插件照常同步，页面提示升级 DSH。
3. `includeConfigs`：彻底移除（插件配置不备份），删掉死代码与误导性配置项。
4. 多 profile：0.3.0 仍只支持单 profile；策略结构预留 profile 字段。
5. 备份按钮：只在明确本机删除时写删除意图；失败导致的缺失绝不写。
6. 发布节奏：不单独发 0.2.14；热修内容并入 0.3.0，优先完成后再做 v2 仓库模型。
7. 设计方向：按本文档实施。
