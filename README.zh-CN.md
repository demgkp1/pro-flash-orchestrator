# Pro-Flash Orchestrator

面向 Google Antigravity 的生命周期 Hook 协同分流引擎，并提供独立打包的 Codex 适配器与 Claude Code Hook 模板。

面向通用软件工程、代码审查、Bug 排查、重构与文档研读。通过确定性的物理 Hook 守门，让旗舰主模型（Pro）聚焦核心架构决策与标杆实现，并将多文件探路、外围扩写与单元测试分流给轻量助手（Flash / Hydrogen）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.7.2-blue.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%20%7C%20Codex%20%7C%20Claude%20Code-lightgrey.svg)](#多平台支持与验收状态)
[![Tests](https://img.shields.io/badge/Offline%20Suites-7%20Passed-green.svg)](#诊断与测试)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 核心定位与三明治协同

在长程开发会话中，仅靠旗舰模型包揽全部工作会导致**高昂配额损耗**与**大文件倾倒导致的上下文退化**；而 System Prompt 中的软性分流提示在长对话中极易漂移失效。Pro-Flash Orchestrator 在 `SessionStart`、`PreInvocation` 与 `PreToolUse` 阶段施加物理拦截与参数改写，确保协同纪律稳定执行。

### 三明治协同闭环 (`/flash-dev`)

1. **探路**：面对未知目录、≥3 个文件或长文档/大代码，先派 `research` 提取结构化摘要与精确行号。
2. **标杆 + 并发扇出**：Pro 亲自落盘核心 Schema、算法或标杆文件（≤2 个），并在**同一轮**并发派发 `self` 子代理扩写外围模块与单测。
3. **终审抽检**：收到四列表格汇报后，Pro 通过 `git status --porcelain` 确认改动范围，并借助 Audit 动态切片配额抽检 20–60 行代码。

```text
[ 用户输入 / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│         Pro 主控架构师 (旗舰模型)       │
│  - 核心架构与标杆实现 (≤2 个文件)       │
│  - 同轮并发扇出子代理 (≤5 个)           │
└───────────────────┬────────────────────┘
                    │ invoke_subagent / define_subagent
                    ▼
┌────────────────────────────────────────┐
│       物理生命周期 Hook 守门体系        │
│  - AGY v1.5.11+ 官方档位别名路由        │
│  - 注入 [FLASH-WORKER] 与四列表格契约   │
│  - 读写配额限制与同批文件互斥锁         │
│  - 防递归、禁轮询与死循环熔断器         │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│        Worker 助手 (Hydrogen / Flash)  │
│  - 探路或修改严格互斥的指定文件         │
│  - 执行局部单测自检                     │
│  - 仅按四列表格格式回报结果             │
└───────────────────┬────────────────────┘
                    │ 消息回报
                    ▼
┌────────────────────────────────────────┐
│         Pro Audit 切片抽检验收         │
│  - 核对 git status 与 Audit 切片抽检    │
└────────────────────────────────────────┘
```

---

## v0.7.2 最新特性

- **双轨验收契约架构（Dual-Track Acceptance Contracts）**：彻底解耦工程实现与认知调研的验收规范与交付要求。
  - **工程实现轨（`self`）**：保持结构化四列表格（`| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |`）与多代理并发边界红线（专属写入互斥隔离、单文件局部测试）。严禁回贴 >10 行源码（单段 ≤10 行），完整分析写入 artifact 目录。
  - **深度研报轨（`research` / 典范模式）**：废除旧版 ≤30 行字数限制，单代理探路派单自动注入【深度研报契约】，要求按典范报告格式深度剖析关键模块、列举代码行号实证、诊断风险瓶颈与产出 Top 优化建议，直接在消息中完整结构化交付。
- **并发扇出动静分离与报告落盘（Concurrent Fan-Out Dynamic/Static Separation）**：同轮多代理并发调研场景下，智能切换为【并发调研契约】，驱动子代理将长篇深度研报落盘至 `reports/<task>.md`，消息中仅保留核心结论速查、证据矩阵与 Top 建议索引，杜绝多代理并发汇报对主会话上下文的洪泛冲击。
- **规范镜像同步与测试强化**：确保根目录镜像（`SKILL.md` ↔ `skills/flash-dev/SKILL.md`、`AGENTS.md` ↔ `rules/AGENTS.md`）保持严格的字节级与换行符一致；新增 `scripts/test-contract-dual-track.mjs` 测试套件，全覆盖验证双轨契约与并发报告落盘机制。
- **完整继承 v0.7.1 全部特性**：Gemini 4 Neon 与 Orchestrator (Neon) 支持、AGY v1.5.11+ 官方档位映射、免 Git 一键升级（`update.mjs`）、子代理死循环熔断器、动态 Audit 切片配额与同批源码互斥锁。

---

## v0.7.1 最新特性

- **完整支持 Gemini 4 Neon 与原生 Orchestrator**：全面识别 `Gemini 4 Neon`（`gemini-4-neon-low/medium/high/xhigh`，Pro/Ultra/Enterprise 默认主力主模型）及 `Argon` / `Carbon` / `Hydrogen`，并将 `Orchestrator (Neon)` / `Orchestrator (Argon)` 识别为原生编排入口（自动启用 `Lite Guard Mode`）。
- **对齐 AGY v1.5.11+ 官方档位映射**：`invoke_subagent` 统一通过合法档位别名路由：`flash` → `Gemini 4 Hydrogen High`，`[FORCE-PRO]` 下的 `pro` → `Gemini 4 Hydrogen XHigh`，Hydrogen 主会话 `inherit` → 继承 Hydrogen。
- **免 Git 一键在线升级与零阻塞版本检测**：`check-update-worker.mjs` 在 `SessionStart` 阶段异步检测 GitHub Releases（缓存至 `.state/update-check.json`，会话启动零延迟；可通过 `PRO_NO_UPDATE_CHECK=1` 关闭）。Release 用户无需 Git 即可通过 `node "<安装目录>/scripts/update.mjs"` 原地覆盖升级，100% 保留 `.state/` 配置与日志。
- **子代理死循环熔断器 (Thrashing Circuit Breaker)**：`guard-command.mjs` 实时追踪子代理连续重复执行的相同命令；达到 `PRO_THRASH_LIMIT`（默认 `3` 次，最低 `2` 次）时触发物理硬拦截（`deny`），强制终止重试并交由 Pro 主控接管。

---

## 快速安装与免 Git 升级

v0.7.2 发布两个独立的 Release 资产包：

- `pro-flash-orchestrator-antigravity-v0.7.2.zip`（根目录为 `pro-flash-orchestrator/`）
- `pro-flash-orchestrator-codex-v0.7.2.zip`（根目录为 `pro-flash-orchestrator-codex/`，独立插件位于 `plugins/pro-flash-orchestrator/`）

### 方式一：Release 用户免 Git 在线 / 离线升级

```bash
# 在线升级（自动拉取最新 pro-flash-orchestrator-antigravity-v*.zip，完整保留 .state/）
node "<插件安装目录>/scripts/update.mjs"

# 使用本地已下载的 ZIP 包离线升级
node "<插件安装目录>/scripts/update.mjs" --zip "path/to/pro-flash-orchestrator-antigravity-v0.7.2.zip"

# 预览变更但不写入磁盘
node "<插件安装目录>/scripts/update.mjs" --dry-run
```

### 方式二：源码仓库部署安装 (Antigravity)

```bash
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/Projects/pro-flash-orchestrator
cd ~/Projects/pro-flash-orchestrator
node scripts/install.mjs
```

- 默认安装路径：`~/.gemini/config/plugins/pro-flash-orchestrator`（可用 `--target <目录>` 指定，`--dry-run` 预览）。
- 仅部署 `runtime-files.json` 白名单内的运行文件；自动保留 `.state/`，不复制 Git、测试或 CI 文件。

---

## 核心守门机制与策略

### 主会话策略矩阵

| 策略 | 适用场景 | 读取配额 | 写入配额 | 行为说明 |
| :--- | :--- | :--- | :--- | :--- |
| **标准主会话** | 旗舰主模型（`Neon`、`Argon`、`Carbon`） | **3** 个不同文件 | **2** 个源码文件 | 严格限制主控直读与标杆直改上限，超出需外派子代理。 |
| **Flash 主会话宽松策略** | `flash-main-relaxed`（Flash 主会话） | **6** 个不同文件 | **4** 个源码文件 | 放宽轻量主会话的读写计数阈值，同时保留切片、防泄洪与契约守门。 |
| **原生编排轻量模式 (`Lite Guard Mode`)** | `Orchestrator (Neon)` / `Orchestrator (Argon)` 或 `PRO_NATIVE_ORCHESTRATOR=1` | 计数豁免 | 计数豁免 | 豁免主控读写文件数量拦截与数量漂移催派；保留超大文件切片、防嵌套、禁轮询、派单契约、命令守门与子代理文件互斥锁。 |

### 物理守门矩阵

| 守门机制 | 挂载钩子 | 判定逻辑与实际收益 |
| :--- | :--- | :--- |
| **角色初始化与状态卡** | `SessionStart` | 主会话启动时单次注入全场景规则（子代理自动跳过）；通过 `renderInfo` 渲染零 Token 消耗的 UI 状态卡片。 |
| **Worker 模型路由** | `PreToolUse` (`invoke_subagent`) | 校验合法枚举（`inherit`、`flash_lite`、`flash`、`pro`），并按 AGY `v1.5.11+` 档位映射路由（`Hydrogen` → `inherit`；其他 → `flash`；`[FORCE-PRO]` → `pro`）。 |
| **Audit 动态切片额度** | `PreToolUse` (`read_file`, `view_file`) | 每次放行 `self` 派单增加 **+2** 切片抽检额度（上限 **10**）。明确起止行号且 ≤80 行时优先消耗额度，支持连续抽检多个子代理改动文件；新用户轮次清零。 |
| **切片防泄洪与多文件拦截** | `PreToolUse` (`read_file`, `view_file`) | 未切片的 300–800 行代码自动收窄至 `[1, 150]`；>800 行代码或 >400 行文档直接拦截。拦截 Minified 单行压缩文件（>40KB 且平均行长 >4KB）。依赖库与 Artifact 路径豁免。 |
| **同批次文件互斥锁** | `PreToolUse`（`write_file`, `edit_file`, `apply_patch`） | 在父 Session 的 `batchFileClaims` 中原子检查并认领归一化目标路径。同一子代理可重试，跨子代理冲突直接拒绝；新批次或新 Audit ID 释放认领。 |
| **防递归与防轮询** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `manage_subagents`) | 严禁子代理嵌套派单，拦截 `manage_subagents(Action="list")` 轮询（放行 `Action="kill"`）；基于父会话元数据与转录证据识别身份。 |
| **中立契约注入** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | 自动注入 `[FLASH-WORKER]` 与 `[PRO-CONTRACT]`，要求工程子代理返回四列表格与局部自检结果（`research` 仅输出结构化摘要，禁止写文件）。 |
| **命令守门与死循环熔断** | `PreToolUse` (`run_command`) | 递归解包嵌套 Shell 与管道；拦截无界 `git log` 与 >400KB `cat`/`Get-Content` 倾倒（放行重定向与 PowerShell `select` 切片）；连续 `PRO_THRASH_LIMIT`（默认 3）次相同命令触发物理熔断。 |
| **轮次唤醒与漂移告警** | `PreInvocation` | 长会话（`globalStep >= 8`）轮次起始注入单行瞬态唤醒，并对去重后的连续读写漂移发出单轮告警（Flash 主会话与原生 Orchestrator 自动降噪）。 |
| **省流遥测统计** | `report.mjs` | 运行 `node scripts/report.mjs [--days 7]` 汇总启动策略，并按被拦截读取与切片收窄行距估算节省的 Token（按 4 bytes/token 换算，自动排除 `shadow` 与测试记录）。 |

### 运行模式与环境变量

可在 `.state/mode.json` 中配置 `{ "mode": "enforce" | "shadow" | "off" }`（受物理守门保护，严禁代理修改），或设置环境变量：

- `PRO_MODE`：`enforce`（默认）、`shadow`（仅记录决策不拦截）、`off`（完全旁路）。
- `PRO_NO_UPDATE_CHECK=1`：禁用后台 GitHub Release 更新检测。
- `PRO_THRASH_LIMIT=3`：子代理连续相同命令触发熔断的阈值（最低 `2`）。
- `PRO_NATIVE_ORCHESTRATOR=1`：强制启用 `Lite Guard Mode`。
- `PRO_STATE_DIR` / `PRO_LOG_PASS=1`：自定义状态目录或记录放行决策。

---

## 多平台支持与验收状态

| 平台 | 当前状态 | 说明 |
| :--- | :--- | :--- |
| **Google Antigravity** | **主力完整支持** | 生产级生命周期 Hook 守门、AGY `v1.5.11+` 档位路由、Audit 动态切片配额与免 Git `update.mjs`。 |
| **OpenAI Codex CLI** | **分阶段原生验收中** | 独立打包（`pro-flash-orchestrator-codex-v0.7.2.zip`）。六个用户级原生 Hook 已由用户审阅为 trusted 并观察到桌面端 `PreToolUse`，但完整原生守门覆盖与端到端原生助手派发闭环仍待验收，**不宣称已在 Codex 完整可用**。详见 [Codex 适配器验收证据](docs/codex-acceptance-v0.5.2.md)。 |
| **Claude Code** | **仅提供配置模板** | 提供 `hooks/claude-settings-hooks.json` 钩子适配模板，尚未进行实机真实验证。 |

### Codex 独立本地 Marketplace 安装

解压 `pro-flash-orchestrator-codex-v0.7.2.zip` 并进入 Marketplace 根目录：

```bash
node install.mjs
node doctor.mjs
```

在桌面端 **Settings > Hooks** 或 CLI `/hooks` 中审阅并信任六个 Pro-Flash Hook，在 `CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json` 中配置对应提供商的 Worker 模型后运行验证：

```bash
node doctor.mjs --verify-worker
node doctor.mjs
```

注销卸载：`node install.mjs --uninstall`（保留 `CODEX_HOME/plugin-data/pro-flash-orchestrator` 配置目录）。

---

## 诊断与测试

### 环境体检与省流复盘

```bash
node scripts/doctor.mjs          # 宿主能力快照 (strategy, hasHydrogen, source)、互斥锁与报告检查
node scripts/report.mjs          # 查看近 7 天真实会话守门统计与上下文省流估算
```

### 离线测试套件（不调用外部 API）

```bash
node scripts/test-concurrency.mjs   # 多进程并发原子锁与协同守门集成压测
node scripts/test-regressions.mjs   # 身份隔离、批量补丁、配额、命令守门与路由回归测试
node scripts/test-v060.mjs          # v0.6.x 策略、Audit 动态切片配额与 Lite Guard Mode 测试
node scripts/test-capabilities.mjs  # AGY 能力探测与 v1.5.11+ 官方档位映射测试
node scripts/test-install.mjs       # 运行时白名单边界与 .state/ 保留测试
node scripts/test-codex.mjs         # 离线 Codex 协议与精确打包白名单测试
node scripts/test-update.mjs        # 后台版本检测与免 Git 原地升级测试
```

### 构建运行包

```bash
node scripts/package.mjs --runtime --platform antigravity --worktree
node scripts/package.mjs --runtime --platform codex --worktree
```

---

## 已知限制

- **管道与重定向旁路 (S5)**：通过 `run_command` 执行的流式命令（`head`、`grep`、`sed`、`>`）受命令防倾倒守门监控，但不计入 `read_file`/`write_file` 配额，也不参与 `batchFileClaims` 认领。
- **Codex 与 Claude Code**：Codex Hosted tools、Hook 超时及已批准交互 Shell 的后续输入可能不在原生 Hook 覆盖范围内；Claude Code 与账户登录尚未实机验证。

---

## 目录结构

```text
pro-flash-orchestrator/
├── adapters/codex/                # Codex 独立 Marketplace 入口、Hook 与技能
├── assets/logo.svg                # 插件图标
├── docs/                          # INSTALL 模板、审计记录与 Codex 验收证据
├── hooks/                         # Claude Code 与 Codex CLI 钩子适配配置
├── hooks.json                     # Antigravity 生命周期钩子路由
├── plugin.json                    # Antigravity 插件清单 (v0.7.2)
├── rules/AGENTS.md                # 常驻架构师与助手规范（根目录 AGENTS.md 为其镜像）
├── runtime-files.json             # 运行时分发白名单
├── skills/flash-dev/SKILL.md      # /flash-dev 工作流技能（根目录 SKILL.md 为其镜像）
└── scripts/
    ├── lib.mjs                    # 核心共享库、状态锁、能力与模式解析
    ├── session-start.mjs          # 启动角色注入、状态卡与后台更新触发
    ├── pre-invocation.mjs         # 轮次边界唤醒与去重漂移检测
    ├── guard-subagent.mjs         # 防递归、禁轮询、档位路由与契约注入
    ├── guard-read-file.mjs        # 智能切片、Audit 动态配额与连读拦截
    ├── guard-write-file.mjs       # 标杆写入上限与 batchFileClaims 互斥锁
    ├── guard-command.mjs          # 命令解包、防倾倒与死循环熔断器
    ├── check-update-worker.mjs    # 零阻塞后台 GitHub Release 检测器
    ├── update.mjs                 # 严格保留 .state/ 的免 Git 原地升级工具
    ├── install.mjs                # Antigravity 与 Codex 安装脚本
    ├── package.mjs                # 多平台发布打包脚本
    ├── doctor.mjs                 # 诊断断言与实时能力快照
    ├── report.mjs                 # 决策遥测与省流估算复盘
    ├── codex-*.mjs                # Codex 原生 Hook、运行时、安装与维护桥接
    └── test-*.mjs                 # 离线验证与回归测试套件
```

## 开源许可证

本项目基于 [MIT 许可证](LICENSE) 发布。
