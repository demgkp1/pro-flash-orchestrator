---
name: flash-dev
description: >-
  启用 v0.6.1「Pro 主控架构师 + Flash 工程助手」全场景通用分流工作流。Whenever the task involves reading >=3 files, exploring an unfamiliar codebase, debugging/fixing multi-file issues, code review, refactoring, writing tests, or building any feature/script/UI/backend/algorithm (>50 lines or >=2 files), use this workflow to delegate exploration and implementation to flash. 派单契约由 Hook 自动注入（[PRO-CONTRACT]）。
---

# `/flash-dev` (v0.6.1)：主控标杆 + Flash 执行工作流

> 模型路由、防嵌套、写入与切片守门均由 Hook 兜底。Hook 根据启动探测结果、主模型与任务配置自动路由最佳可用 Worker：Hydrogen 主会话使用 `Model="inherit"`，其他主会话默认使用 `Model="flash"`。派单后静默等待，严禁 `manage_subagents` 轮询。

## 1. 三明治协同四步法

1. **探路（`research`）**：目标未知、查 ≥3 文件或长代码时派发，提取结构与根因，严禁切片连读。
2. **标杆（Pro 直写）**：Pro 亲自落盘核心接口、数据结构、算法或标杆组件（≤2 文件）。
3. **外派（`self`）**：同轮并发发出 `invoke_subagent` 派发外围模块与测试，零等待外派。
4. **终审（Audit）**：`git status --porcelain` 查范围，按汇报行号抽检 20–60 行，复跑集成验证。

## 原生 Orchestrator 与终审额度

`Orchestrator (Argon)`（`modelName` / `model` 匹配 `/orchestrator/i`）或 `PRO_NATIVE_ORCHESTRATOR=1` 启用 **Lite Guard Mode**。原生编排自主读写与派单，保留自身的 Hydrogen 路由并豁免文件数量拦截与数量漂移催派；超大文件切片、防嵌套、禁轮询、派单契约、命令守门和子代理文件互斥锁继续生效。

会话初始为 `explore`。每次放行 `self` 派单进入 `audit` 并增加 2 次切片额度，上限 10；明确起止行号且 ≤80 行时优先消耗额度，支持跨文件连读抽检。子代理完成后的 Audit 唤醒保留阶段与额度，普通新用户轮次重置；额度耗尽后恢复普通读取配额。父子会话各保留最近 10 条脱敏命令摘要；本批缺命令证据时提醒核实。`PreToolUse` 放行不等于执行成功，四列表格仍须提供真实测试结果。

`PRO_RESEARCH_MODEL` / `PRO_SELF_MODEL` 分别指定探路与实现模型，优先于 `PRO_WORKER_MODEL`；Antigravity 当前配置应使用合法枚举，如 `inherit` / `flash`。默认 Claude 为 `haiku`、Codex 为 `gpt-5-mini`。Codex 原生入口继续验证实际选中模型的提供方与证明，已有用户配置保留。

## AGY 启动探测与动态策略

AGY 代号：`Argon` / `Carbon` 为 Gemini 4 主模型，`Hydrogen` 为 Gemini 4 轻量 Worker，`Orchestrator (Argon)` 为原生编排入口；`Gemini 3.8 Flash` / `Flash` 为轻量主模型或降级 Worker。

仅主会话 `SessionStart` 执行有界的 `agy models` 探测，结果写入 `STATE_DIR/capabilities.json`。相同 AGY 父进程内复用不足 12 小时的结果，跨终端复用不足 1 小时的结果；后续 PreInvocation / PreToolUse 只读缓存。桌面端 CLI 不可用时从 Argon / Carbon / Hydrogen / Orchestrator 主模型推断权限；明确 CLI 无 Hydrogen 权限时保持 Flash 回退。

Antigravity 的 `invoke_subagent.Model` 当前只接受小写枚举 `inherit`、`flash_lite`、`flash`、`pro`。Hydrogen 主会话识别为 `hydrogen-main`，使用 `inherit` 让子代理继承 Gemini 4 Hydrogen。其他主会话默认使用合法的 `flash`；`hydrogen-worker` 表示探测到 Hydrogen 能力，`flash-fallback` 表示按 Flash 回退，两者保持严格分流。启动卡片显示实际推荐的 research / self 参数。

`PRO_HYDROGEN_ID` 供未来宿主 Schema 开放自定义模型 ID 时显式配置；仅在 `hasHydrogen === true` 时生效，任务与通用模型环境变量仍优先。当前模板使用合法枚举，避免直接传入未获 Schema 支持的 `hydrogen`。

AGY 非子代理主模型为 Flash 时启用 `flash-main-relaxed`：普通读取最多 6 个文件、源码直改最多 4 个文件，避免小任务派生同级 Worker；子代理不触发此策略。Audit 的 ≤80 行切片额度、大文件保护与 Lite 原生编排豁免继续生效。

## 2. 并发三铁律（Fan-out Swarm）

跨模块、前后端或多维调研时，单轮扇出 2~5 个 Flash 子代理并行：
1. **同轮扇出（Fan-out）**：单轮上限 5 个，同轮并发派发全部子代理，严禁串行等待；派完立即静默等待唤醒。
2. **互斥分区（Disjoint Sets）**：专属修改文件严格互斥，严禁重叠；自检仅限单文件局部测试，严禁全量构建。
3. **聚合终审（Audit）**：按四列表格汇报后，Pro 统一通过 `git status --porcelain` 与抽检验收。

非豁免源码写入由父 Session 的 `batchFileClaims` 执行同批次文件互斥：Hook 在物理 Session 锁内按归一化路径原子认领，Windows 路径忽略大小写。同一子代理可重复修改已认领文件；其他子代理命中同一文件会被拒绝，应将所需变更列入最终四列表格交主控统一合并。多文件操作先检查全部目标，冲突时不新增任何认领；新批次或新 `auditBatchId` 清空认领，同批次续派保留。Artifact 与依赖等豁免路径不参与认领。

派单契约携带 `[PRO-PARENT:<id>]`，无需依赖 payload 始终提供父 ID。父子关联优先采用显式父 ID、转录或契约标识；`last_spawn.json` 只在角色已确认后恢复已认领记录或唯一候选父会话，多个候选父会话不按时间猜选。无法关联或状态持久化失败时拒绝 AGY 源码写入，将需求交主控合并。根目录 `SKILL.md` / `AGENTS.md` 是对应规范文件的同步镜像，`test-v060.mjs` 检查一致性。

## 3. 标准派单模板

> **跨平台等价调用**：Antigravity: `invoke_subagent(Model="inherit")`（Hook 自动路由，Hydrogen 主会话继承，其他主会话默认 `flash`） / Claude Code: `Agent` 或 `Task(model="haiku")` / Codex CLI: `spawn_agent(model="gpt-5-mini")`（Hook 自动归一化各平台工具并注入对应轻量模型与契约）。

### 探路调研（`TypeName="research"`, `Model="inherit"`，由 Hook 自动路由）
```text
[FLASH-WORKER] 调研：<路径/目录/代码库/日志>
提取功能清单、关键行号、根因与受影响文件列表，直接在消息中返回，严禁粘贴长源码。
```

### 工程实现（`TypeName="self"`, `Model="inherit"`，由 Hook 自动路由）
```text
[FLASH-WORKER] 严格基于标杆实现（禁止再派单）：
1. 必读标杆：<Pro 写入的核心文件绝对路径>
2. 专属修改（互斥红线）：<目标文件路径与实现要求>
3. 局部自测：仅运行单模块测试 <npm test path/to/test>，报错自行闭环。
```

## 4. 汇报契约（Hook 自动追加）

| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |
| :--- | :--- | :--- | :--- |

- 完整分析写入 artifact 目录，聊天仅回四列表格。
- 严禁粘贴 >10 行源码；自检命令必须真实执行并提供明确结果。
