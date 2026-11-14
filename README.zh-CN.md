# Pro-Flash Orchestrator

面向 Google Antigravity 的生命周期 Hook 协同分流引擎，并提供独立打包的 Codex 适配器。

面向日常编程、代码审查、Bug 排查、重构与文档研读。旗舰模型负责核心决策与标杆实现，已验证的轻量助手负责外围工程、测试与探索。Antigravity 是既有运行路径；v0.7.0 包含独立安装、仍处于分阶段原生验收中的 Codex 集成。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.7.0-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%20%7C%20Codex-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Offline%20Suites-8%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 设计背景

在大模型辅助软件工程中，依赖旗舰模型（Pro）完成全部任务通常会导致两类不可逆的损耗：

1. 经济与配额损耗：旗舰模型在处理机械化 CRUD、数据转换、批量单测编写等工程体力活时，消耗了高昂的高级配额。
2. 上下文退化：当模型无界倾倒大文件（如直接 `cat` 或通读超大代码与日志）时，上下文窗口迅速被噪声填满，导致后续逻辑推理能力下降。

单纯在 System Prompt 中加入软性提示（例如“请外派子代理”）在长程交互中极易因模型注意力漂移而失效。Pro-Flash Orchestrator 采用 Antigravity 原生生命周期 Hook，在工具执行前（PreToolUse）、模型调用前（PreInvocation）及会话初始化（SessionStart）施加确定性的物理校验与自动化改写。

---

## v0.7.0 守门更新

v0.7.0 版本引入了零阻塞后台更新检测与免 Git 一键在线升级，新增子代理死循环熔断器（Thrashing Circuit Breaker），并对 Antigravity 模型探测、枚举安全校验与命令解析稳定性进行了全面强化：

- **零阻塞后台版本检测与免 Git 一键升级**：`check-update-worker.mjs` 在 `SessionStart` 阶段异步静默检测 GitHub Releases，结果缓存至 `.state/update-check.json`，会话启动零网络延迟；检测到新版以 UI 卡片优雅提醒，支持 `PRO_NO_UPDATE_CHECK=1` 环境变量完全禁用。普通 Release 用户无需维护 Git 仓库，执行 `node "<插件安装目录>/scripts/update.mjs"` 即可拉取最新精简 Release 资产包覆盖升级，严格进行路径防逃逸检查并 100% 保留本地 `.state/` 状态配置。支持 `--zip <path>` 离线升级与 `--dry-run` 预览。
- **子代理死循环熔断器 (Thrashing Circuit Breaker)**：在 `guard-command.mjs` 中实时跟踪子代理执行历史。当检测到子代理在同一任务批次内连续重复执行相同失败命令达到上限（`PRO_THRASH_LIMIT` 环境变量控制，默认 3 次，即连续失败重试 2 次）时，触发硬拦截（`deny`），物理熔断循环，强制子代理停止工具调用并按四列表格将错误信息交 Pro 主控接管修复。
- **AGY 探测超时修复与模型枚举安全**：将 `agy models` 探测超时阈值放宽至 5500ms，在 Windows 平台直接调用 `cmd.exe /c agy.cmd models` 规避脚本执行失败与级联超时。引入 `INVOCABLE_SUBAGENT_MODELS` 白名单校验，确保子代理派单模型严格限定于 Antigravity 合法小写枚举（`inherit`、`flash_lite`、`flash`、`pro`），杜绝非法标识传入。
- **PowerShell 管道别名与会话稳定性**：`guard-command.mjs` 识别 PowerShell `select` 别名（对应 `Select-Object`）在管道切片（`-First`/`-Last`）与只读判定中的语义。子代理命令记录前检查 `sessionExists`，防止生成空骨架父会话文件。`scripts/install.mjs` 在对比文件时对 CRLF 与 LF 换行符归一化，消除误判覆写。
- **完整继承既有守门体系**：Hydrogen 继承（`inherit`）、Flash 主模型宽松策略（`flash-main-relaxed`，最多读 6 改 4）、原生 Orchestrator Lite Guard Mode、同批次源码互斥物理锁、Audit 抽检配额（≤80行）以及递归/轮询拦截机制均持续稳定生效。

## 协同分工模型

### 全场景分流原则（按规模分流，不限语言、框架与领域）
- **探路与审阅（≥3 个文件或长文档/大代码）**：必须外派 `research (flash)` 提取结构化摘要与精确行号，禁止主模型并发切片连读。
- **工程实现与批量修复（>50 行或 ≥2 个文件）**：Pro 亲自落盘核心标杆/关键算法，同轮并发外派 `self (flash)` 扩写外围与回归单测。
- **单点微调（≤50 行、≤2 个已知文件）**：Pro 亲自切片直改（反向止损，避免多轮派单延迟）。

```text
[ 用户输入 / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│         Pro 主创架构师 (旗舰模型)       │
│  - 全场景通用：编程/审阅/排错/重构/文档 │
│  - 亲自把控核心决策与标杆实现 (Benchmark)│
│  - 同轮并发派发子代理                  │
└───────────────────┬────────────────────┘
                    │ invoke_subagent / define_subagent
                    ▼
┌────────────────────────────────────────┐
│       Hook 守门拦截 (Physical Guards)  │
│  - 按启动能力路由: Hydrogen→inherit   │
│  - 其他主会话的 Worker 默认使用 flash │
│  - 自动注入 [FLASH-WORKER] 与汇报契约  │
│  - 递归与轮询阻断: 禁止套娃与 list 轮询│
│  - 读写守门: 截断切片连读 & 限制写入标杆│
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│       Worker 执行助手 (Hydrogen/Flash) │
│  - 按主模型与启动能力执行探路和扩写   │
│  - 运行真实命令自检 (自闭环报错)       │
│  - 仅返回结构化四列表格，禁止大段源码  │
└───────────────────┬────────────────────┘
                    │ 消息回报
                    ▼
┌────────────────────────────────────────┐
│         Pro 切片抽检验收 (Audit)       │
│  - 查看 git status 范围                │
│  - 按汇报行号切片抽检 20-60 行         │
└────────────────────────────────────────┘
```

---

## 物理守门机制矩阵

| 守门机制 | 挂载钩子 | 判定与处理规则 | 经济与上下文收益 |
| :--- | :--- | :--- | :--- |
| **角色与契约初始化** | `SessionStart` | 会话启动时单次注入全场景分工规则；状态卡片通过 `renderInfo` 投递至 UI 渲染层。子代理启动自动跳过角色注入。 | 状态卡片对大模型零 Token 消耗，不侵占上下文。 |
| **Worker 模型路由** | `PreToolUse` (`invoke_subagent`) | 按启动能力与主模型选择合法参数：Hydrogen 主会话使用 `inherit`，其他主会话默认使用 `flash`。任务配置优先；原生 Orchestrator 路由与用户显式 `[FORCE-PRO]` 选择保留。 | 使用宿主兼容参数调用最佳可用 Worker。 |
| **写入守门与标杆约束** | `PreToolUse` (`write_file`, `edit_file` 等) | 维护 `writesSinceDispatch`，严格主控策略最多直改 2 个源码文件，`flash-main-relaxed` 最多 4 个；继续修改不同文件需外派。子代理豁免主控配额，Artifact 与依赖/构建路径豁免。 | 聚焦核心标杆，同轮外派外围工程。 |
| **同批次文件互斥锁** | `PreToolUse`（源码写入与 `apply_patch`） | 在父 Session 的 `batchFileClaims` 中原子检查并认领全部归一化目标。同一子代理可重试，其他子代理认领冲突则拒绝；新批次或新 Audit ID 释放认领，同批次续派保留。 | 防止并行子代理交叉修改导致覆盖。 |
| **冷启动、递归与轮询拦截** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `manage_subagents`) | 1. **身份须有证据**：依据父会话元数据、子代理转录或冷启动契约标记识别身份；最近派单记录不能单独作为身份依据，认领必须匹配明确的父会话；<br>2. **递归阻断**：严格拦截子代理套娃派单（`deny`）；<br>3. **轮询拦截**：拦截主模型调用 `manage_subagents(Action="list")` 轮询子代理状态，消除等待期间无效 Token 消耗与异步抢改，引导直接结束回合静默等待系统唤醒（`Action="kill"` 放行）。 | 消除多层死循环、抢跑改写与轮询上下文浪费，保证异步协同秩序。 |
| **中立契约与自定义守门** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | 派单、自定义代理定义（`define_subagent`）及消息追加自动注入 `[FLASH-WORKER]` 与契约：工程子代理必须返回四列表格+自检命令与结果，`research` 调研子代理直接输出结构化摘要无需写文件。`artifactDirectoryPath` 丢失时安全回退至绝对路径 `~/.gemini/antigravity/brain/<convId>`。 | 消除大段源码回贴与只读沙箱写文件异常，防止工作区根目录污染。 |
| **切片防泄洪与多文件连读拦截** | `PreToolUse` (`read_file`, `view_file`) | 1. **智能切片**：未显式切片读取代码文件（300-800行）自动收窄至 [1, 150] 行，>800 行代码或 >400 行文档/日志直接拦截引导派单；<br>2. **防泄洪增强**：文件 >40KB 且平均行长 >4KB（Minified 压缩代码/数据）一律物理拦截；<br>3. **多文件切片连读拦截**：维护 `readsSinceDispatch`，主模型试图切片连读第 4 个不同源码/文档文件触发硬拦截（`deny`），强制改派 `research (flash)`。自动豁免依赖库与 Artifact 目录。 | 消除单行压缩数据穿透与超大文件撑爆上下文的隐患，彻底阻断主模型以切片形式逐个连读多文件探路。 |
| **命令防倾倒与死循环熔断器** | `PreToolUse` (`run_command`) | 递归解包多层嵌套 Shell；按顶层管道切分判定；拦截未分页的 `git log` 与针对 >400KB 文件的无界 `cat`/`Get-Content`。覆盖变量赋值、子表达式及 .NET 静态方法；放行文件重定向输出；精准识别 PowerShell `select` 别名。**死循环熔断器**：实时追踪子代理执行历史，连续重复执行相同失败命令达到 `PRO_THRASH_LIMIT`（默认 3 次）时物理硬拦截（`deny`），阻断重试并强制四列表格汇报交 Pro 主控接管。 | 杜绝终端海量日志倾倒，消除代码逃逸；杜绝子代理盲目死循环重试与 Token 浪费，确保主控及时介入修复。 |
| **轮次边界唤醒与去重漂移感知** | `PreInvocation` | 1. **长会话轮次边界唤醒**：基于 `globalStep >= 8` 判定，在用户新需求交互轮次起始处注入瞬态 `ephemeralMessage`，唤醒架构师分流职责，根治长程注意力稀释；<br>2. **去重漂移告警**：基于去重且剔除豁免路径的 `readsSinceDispatch` 与 `writesSinceDispatch`，若连续改写或连读未派单触发单轮即抛告警；<br>3. **精准降噪**：运行时模型切为 Flash 时自动停用架构师漂移告警，彻底过滤文本中工具名字面量的误报。 | 零历史上下文残留，精准告警与轮次唤醒兼备，保障架构师长期自律。 |

---

## 平台运行包与安装

v0.7.0 发布两个相互独立的资产：

- `pro-flash-orchestrator-antigravity-v0.7.0.zip`，根目录为 `pro-flash-orchestrator/`。
- `pro-flash-orchestrator-codex-v0.7.0.zip`，根目录为 `pro-flash-orchestrator-codex/`，独立插件位于 `plugins/pro-flash-orchestrator/`。

### Antigravity

#### 方式一：Release 用户免 Git 一键在线升级（推荐）

通过发布包安装的用户无需配置 Git 仓库或克隆源码，直接在安装目录下执行内置的更新脚本，即可一键在线拉取最新 Release 精简包覆盖升级：

```powershell
node "<插件安装目录>/scripts/update.mjs"
```

升级过程自动从 GitHub Releases 获取最新官方精简包（`pro-flash-orchestrator-antigravity-v*.zip`），执行严格的路径防逃逸与符号链接安全校验，覆盖运行时文件并 100% 保护与保留用户的 `.state/` 状态目录、模式配置及复盘日志。
- 如网络受限，可先手动下载 ZIP 资产包，执行本地离线升级：
  ```powershell
  node "<插件安装目录>/scripts/update.mjs" --zip "path/to/archive.zip"
  ```
- 支持 `--dry-run` 参数预览待更新文件，不产生实际写入。

#### 方式二：源码开发者/维护工程部署安装

维护工程保留 Git、测试与发布工具，Antigravity 安装目录只接收白名单内的运行文件：

```powershell
git clone https://github.com/demgkp1/pro-flash-orchestrator.git "E:\Edoc\Projects\pro-flash-orchestrator"
cd "E:\Edoc\Projects\pro-flash-orchestrator"
node scripts/install.mjs
```

macOS/Linux 可使用 `~/Projects/pro-flash-orchestrator` 等独立维护目录。默认安装到用户目录 `.gemini/config/plugins/pro-flash-orchestrator`；可用 `--target <安装目录>` 指定路径，用 `--dry-run` 预览。部署保留 `.state/`，不复制维护工程的 Git、测试或 CI 文件。

### Codex 独立本地 Marketplace

解压 Codex ZIP，进入 Marketplace 根目录后运行：

```bash
node install.mjs
node doctor.mjs
```

安装器通过官方 `codex plugin marketplace add` 与 `codex plugin add` 命令注册，不修改插件缓存。在验收环境中，Codex CLI `0.167.0-alpha.3.2` 未加载插件内置 Hook，因此安装器还会把六个用户级原生事件连接到 `CODEX_HOME/hooks.json`，同时保留并备份其他 Hook。生成命令包含运行时代码哈希，代码变化后必须重新审阅。

请在桌面端 **Settings > Hooks** 或 CLI `/hooks` 中亲自审阅六个 Pro-Flash Hook、标记为 trusted，并新开会话。随后编辑 `CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json`，验证当前提供商下的精确助手配置：

```bash
node doctor.mjs --verify-worker
node doctor.mjs
```

v0.7.0 分发默认候选为 `gpt-5-mini`、low 推理强度，但必须通过真实请求后才允许派发；模型还必须出现在原生工具可选目录中：当前宿主仅暴露 `gpt-6.1-sol` 与 `gpt-6-astra`，本地 Worker 已配置为 `gpt-6.1-sol`/low。历史探针结果保留在验收文档中；最小 CLI 探针成功不代表原生子代理可用。验证失败或失效时会阻止派发，不会静默回退到主模型。

注销独立集成：

```bash
node install.mjs --uninstall
```

卸载仅移除生成的 Pro-Flash 用户 Hook 与官方注册，保留解压源码和 `CODEX_HOME/plugin-data/pro-flash-orchestrator` 控制配置。

六个用户级原生 Hook 已由用户审阅为 trusted，真实桌面会话也已观察到 `PreToolUse`。完整原生守门覆盖与原生助手派发闭环仍待验收，因此 v0.7.0 不宣称 Codex 已完整可用。账户登录和 Claude Code 也尚未真实验证。证据与待办见 [Codex 适配器验收证据](docs/codex-acceptance-v0.5.2.md)。

### 维护测试与发布打包

公共/离线维护门禁不会调用模型提供商 API：

```powershell
git pull
node scripts/doctor.mjs
node scripts/test-concurrency.mjs
node scripts/test-regressions.mjs
node scripts/test-v060.mjs
node scripts/test-capabilities.mjs
node scripts/test-install.mjs
node scripts/test-codex.mjs
node scripts/test-update.mjs
node scripts/install.mjs
```

分别生成两个运行包：

```powershell
node scripts/package.mjs --runtime --platform antigravity --worktree
node scripts/package.mjs --runtime --platform codex --worktree
```

`runtime-files.json` 与 Codex Marketplace 构建器维护各自的精确白名单。完整源码包使用 `--source --worktree`。已有 Git 安装目录必须先将完整维护工程迁出，再部署运行文件。

v0.7.0 包含上述守门更新与独立平台适配器；原生验收状态继续以所链接的证据为准。

---

## 标准工作流 (/flash-dev)

插件内置 `/flash-dev` 技能，用于规范化驱动主创与助手的协同闭环：

```text
/flash-dev 开发一套后端系统服务（用户认证/订单处理/支付），由你设计数据库Schema、DDD分层与核心标杆Service，同轮并发派发 Flash 扩写其余CRUD、DTO校验与集成测试
```

### 协作闭环步骤

1. 架构标杆落地：Pro 主创编写 Schema、核心 API 接口定义、核心算法或 Design Tokens。
2. 同轮并发外派：在同一交互轮次中发出写文件与 `invoke_subagent` 派单，由 Flash 助手扩写外围模块与配套单测。
3. 切片抽检验收：Flash 助手自测通过后回复四列表格。Pro 主创运行 `git status --porcelain` 检查改动范围，按汇报行号切片抽检 20-60 行代码。

---

## 运行模式配置

| 模式 | 行为特性 | 适用场景 |
| :--- | :--- | :--- |
| `enforce` (默认) | 所有物理守门生效，拦截违规调用并执行改写。 | 正式开发环境。 |
| `shadow` | 仅记录决策数据至 `.state/decisions.jsonl`，不对行为作任何拦截。 | 策略调优与行为观测。 |
| `off` | 完全旁路，所有 Hook 不作任何处理。 | 紧急排障。 |

### 模式配置方式

1. 配置文件（推荐，即时生效）：
   在插件目录的 `.state/mode.json` 中配置：
   ```json
   { "mode": "shadow" }
   ```
   > **安全说明 (S1)**：`.state/mode.json` 属于用户安全配置，只能由人类用户手动编辑修改，受守门机制严格保护，严禁任何 AI 代理通过工具修改或覆盖。
   允许 `Get-Content`、`cat` 等只读查询。批量补丁会检查全部受影响路径（包含重命名目标），再统一校验写入配额。
2. 环境变量（修改后需重启 Antigravity / 终端生效）：
   - 运行模式：
     - Windows PowerShell: `$env:PRO_MODE="shadow"`
     - macOS / Linux: `export PRO_MODE=shadow`
   - 后台更新检测：
     - 设置 `PRO_NO_UPDATE_CHECK=1` 可完全禁用后台 GitHub Release 更新检测与会话启动提醒卡片。
   - 子代理死循环熔断器：
     - 设置 `PRO_THRASH_LIMIT=3`（默认 3 次，最低 2 次）可配置子代理连续重复执行相同命令的熔断阈值，超限后物理拦截并移交 Pro 主控架构师接管。

---

## 自检诊断与决策复盘

### 1. 自动化自检与并发压测套件
运行 doctor 诊断断言，包含报告统计与并发文件互斥自检；最后一行显示当前宿主的 `strategy`、`hasHydrogen` 与 `source`：
```bash
node scripts/doctor.mjs
```

运行多进程并发原子锁与协同守门集成压测：
```bash
node scripts/test-concurrency.mjs
```

运行漏洞回归套件，覆盖身份隔离、批量补丁、锁竞争、轮次配额、命令守门与平台识别：
```bash
node scripts/test-regressions.mjs
```

运行离线 Codex 协议与精确打包白名单测试（不调用提供商/API）：
```bash
node scripts/test-codex.mjs
```

锁竞争时会临时拒绝本次配额更新，可在锁释放后重试工具调用。五个子代理的配额只在新用户轮次重置，读写文件或等待不会重置；轮次 ID 与 `UserPromptSubmit` 事件可区分相同提示词，缺少这些信号的宿主依赖用户输入变化或调用计数回退识别边界。

### 2. 生产决策复盘
查看最近 7 天在真实会话中触发的守门数据（自动剔除测试生成的数据）：
```bash
node scripts/report.mjs
```

指定统计天数：
```bash
node scripts/report.mjs --days 30
```

报告与 Hook 共用 `STATE_DIR` 和 `LOG_FILE`，支持 `PRO_STATE_DIR`、`PLUGIN_DATA` 与 Codex 状态目录。省流估算面板汇总启动策略，并按真实读取拦截与切片实际请求/保留行数估算上下文体积，Token 按 4 bytes/token 换算；shadow 决策不计入真实省流。Codex 独立包提供 `node report.mjs`，读取 Codex 数据目录。

---

## 已知限制

- **管道与重定向旁路 (S5)**：直接通过 `run_command` 执行的 Shell 管道或流式工具（如 `head`、`grep`、`sed`、重定向 `>` 等）主要由命令防倾倒守门检测命令安全性，不计入 `read_file`/`write_file` 的切片连读与标杆写文件配额计数，也不参与同批次文件认领。
- **Codex 验收尚未完成**：Hosted tools、Hook 错误/超时，以及已批准交互 Shell 的后续输入可能不在原生 Hook 覆盖范围内。完整守门与原生助手派发闭环仍待验收；账户登录和 Claude Code 尚未真实验证。

---

根目录 `SKILL.md` / `AGENTS.md` 分别镜像 `skills/flash-dev/SKILL.md` 与 `rules/AGENTS.md`，发布测试验证内容同步。

## 目录结构

```text
pro-flash-orchestrator/
├── adapters/codex/             # Codex 独立 Marketplace 入口、Hook 与技能
├── .github/
│   └── workflows/
│       └── release.yml         # GitHub Actions 自动化发布与打包流水线
├── runtime-files.json          # Runtime distribution manifest
├── docs/INSTALL.md             # Installed README template
├── plugin.json                 # Antigravity 插件配置清单
├── hooks.json                  # 生命周期钩子路由定义
├── hooks/
│   ├── claude-settings-hooks.json # Claude Code 钩子适配配置
│   └── codex-hooks.json        # Codex CLI 钩子适配配置
├── .gitattributes              # 固化 Shell 脚本换行符为 LF
├── LICENSE                     # MIT 开源许可证
├── README.md                   # 英文说明文档
├── README.zh-CN.md             # 中文说明文档
├── rules/
│   └── AGENTS.md               # 常驻主创与助手职责规范
├── skills/
│   └── flash-dev/
│       └── SKILL.md            # /flash-dev 技能描述与提示词模板
├── scripts/
│   ├── lib.mjs                 # 核心共享库（Payload 解析、子代理识别、冷启动派生、日志）
│   ├── session-start.mjs       # 会话初始化引导、状态卡片与后台更新触发
│   ├── check-update-worker.mjs # 零阻塞后台 GitHub Release 版本检测器
│   ├── update.mjs              # 严格保留 .state/ 的免 Git 运行升级工具
│   ├── pre-invocation.mjs      # 轮次边界瞬态唤醒与去重漂移提醒
│   ├── guard-subagent.mjs      # 子代理守门（递归阻断、轮询拦截、物理降级、中立契约）
│   ├── guard-read-file.mjs     # 文件读取守门（智能切片、生态豁免、切片连读拦截）
│   ├── guard-write-file.mjs    # 文件写入守门（标杆配额与同批次文件互斥）
│   ├── guard-command.mjs       # 命令守门（多层解包、重定向放行、倾倒拦截、死循环熔断）
│   ├── doctor.mjs              # doctor 断言、实时能力快照与 Codex 诊断
│   ├── test-concurrency.mjs    # 多进程并发压测与守门集成测试套件
│   ├── test-regressions.mjs    # 已审计漏洞及边界场景的回归测试
│   ├── test-update.mjs         # 后台检测与一键升级本地测试套件
│   ├── install.mjs             # Antigravity 部署与 Codex Marketplace 安装
│   ├── codex-*.mjs             # Codex 原生 Hook、运行时、安装与维护桥接
│   ├── runtime-files.mjs       # Shared runtime allowlist loader
│   ├── test-install.mjs        # Runtime boundary and state preservation tests
│   ├── test-codex.mjs          # 离线 Codex 协议与打包白名单测试
│   ├── package.mjs             # 多平台打包与发布分发脚本
│   └── report.mjs              # 生产决策聚合与统计复盘
└── assets/
    └── logo.svg                # 插件图标
```

---

## 开源许可证

本项目基于 [MIT 许可证](LICENSE) 发布。
