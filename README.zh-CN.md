# Pro-Flash Orchestrator

面向 Google Antigravity 的双级大模型协同分流引擎。

面向一切日常编程、代码审查、Bug 排查、重构与文档研读。由 Pro 模型负责核心决策与标杆实现；Flash 及 Flash-Lite 模型负责外围工程扩写、测试用例编写与文档检索。所有分流策略均下沉至底层生命周期 Hook 进行物理拦截，杜绝上下文膨胀与配额损耗。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.3.0-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%202.0-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Tests-71%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 设计背景

在大模型辅助软件工程中，依赖旗舰模型（Pro）完成全部任务通常会导致两类不可逆的损耗：

1. 经济与配额损耗：旗舰模型在处理机械化 CRUD、数据转换、批量单测编写等工程体力活时，消耗了高昂的高级配额。
2. 上下文退化：当模型无界倾倒大文件（如直接 `cat` 或通读超大代码与日志）时，上下文窗口迅速被噪声填满，导致后续逻辑推理能力下降。

单纯在 System Prompt 中加入软性提示（例如“请外派子代理”）在长程交互中极易因模型注意力漂移而失效。Pro-Flash Orchestrator 采用 Antigravity 原生生命周期 Hook，在工具执行前（PreToolUse）、模型调用前（PreInvocation）及会话初始化（SessionStart）施加确定性的物理校验与自动化改写。

---

## 协同分工模型

### 全场景分流原则（按规模分流，不限语言、框架与领域）
- **探路与审阅（≥3 个文件或长文档/大代码）**：必须外派 `research (flash_lite)` 提取结构化摘要与精确行号，禁止主模型并发切片连读。
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
│  - 物理强制降级: research→flash_lite   │
│                 self/工程→flash        │
│  - 自动注入 [FLASH-WORKER] 与汇报契约  │
│  - 递归阻断: 禁止子代理再次派单        │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│         Flash 执行助手 (轻量模型)      │
│  - 探路(flash_lite) / 机械扩写(flash)  │
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
| **子代理降级增强** | `PreToolUse` (`invoke_subagent`) | 主模型无论 Pro 还是 Flash，`research` 调研子代理一律降级为 `flash_lite` 极轻量模型；`self` 与常规工程子代理降级为 `flash`；仅携带 `[FORCE-PRO]` 时保留旗舰模型。 | 最大化压低调研与工程 Token 开销，杜绝高级配额浪费。 |
| **冷启动与递归派单阻断** | `PreToolUse` (`invoke_subagent`, `define_subagent`) | 派单时自动注入 `[FLASH-WORKER]` 前缀，解决首轮转录未落盘时的冷启动身份识别；通过转录首行 `SYSTEM`/`SYSTEM_SDK` 特征识别子代理身份，严格阻断子代理再次派单（`deny`）。 | 消除无休止的多层子代理调用死循环，防止冷启动误判。 |
| **中立契约与自定义守门** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | 派单、自定义代理定义（`define_subagent`）及消息追加自动注入 `[FLASH-WORKER]` 与契约：工程子代理必须返回四列表格+自检命令与结果，`research` 调研子代理直接输出结构化摘要无需写文件。`artifactDirectoryPath` 丢失时安全回退至绝对路径 `~/.gemini/antigravity/brain/<convId>`。 | 消除大段源码回贴与只读沙箱写文件异常，防止工作区根目录污染。 |
| **大文件切片与 Minified 防泄洪** | `PreToolUse` (`read_file`, `view_file`) | 未显式切片读取代码文件（300-800行）时，自动改写参数限制在 [1, 150] 行内；超过 800 行代码或 400 行文档/数据日志直接拦截，引导使用子代理。**防泄洪增强**：即使传入 StartLine/EndLine，若文件 >40KB 且平均行长 >4KB（如压缩 JS/JSON/Minified 数据）一律物理拦截。自动豁免依赖库与 Artifact 目录。 | 消除超大文件撑爆上下文的隐患，杜绝单行压缩数据穿透，小文件切片无需额外轮次。 |
| **命令防倾倒增强** | `PreToolUse` (`run_command`) | 递归解包多层嵌套 Shell；按顶层管道切分判定；拦截未分页的 `git log` 与针对 >400KB 文件的无界 `cat`/`Get-Content`。**全模式防倾倒**：覆盖变量赋值（`$content = Get-Content`）、子表达式（`Resolve-Path`）及 .NET 静态方法（`[IO.File]::ReadAllText`）。放行真实文件重定向输出（`>`、`>>`、`| Set-Content`、`> /dev/null`）。 | 杜绝终端海量日志倾倒至对话中，封堵全部管道与代码逃逸手段，同时不影响离线写盘。 |
| **会话漂移精准感知** | `PreInvocation` | 解析转录滑动窗口，自上次派单以来若连续 4 次直接改动代码文件且未派单，注入单轮即抛的 `ephemeralMessage` 提醒分流。**精准降噪**：运行时模型切为 Flash 时自动停用架构师漂移告警；严格提取 AST/JSONL toolCall 结构体判定，彻底过滤正文讨论中提及 `write_file`/`edit_file` 等字符串字面量的假阳性误报。 | 保持静默，仅在出现注意力漂移时发出无上下文残留的即时告警。 |

---

## 快速安装

推荐使用单行命令直接克隆至 Antigravity 插件目录：

### Windows (PowerShell)
```powershell
git clone https://github.com/demgkp1/pro-flash-orchestrator.git "$HOME\.gemini\config\plugins\pro-flash-orchestrator"
```

### macOS / Linux (bash / zsh)
```bash
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/.gemini/config/plugins/pro-flash-orchestrator
```

### 插件升级
进入插件所在目录执行拉取即可：
```bash
cd ~/.gemini/config/plugins/pro-flash-orchestrator && git pull
```

<details>
<summary>开发者模式（从自定义代码仓库软链接安装）</summary>

若需在个人代码工作区（如 `~/projects/pro-flash-orchestrator`）内对插件进行二次开发：

- Windows：
  ```powershell
  cd <工作区目录>
  .\install.ps1
  ```
- macOS / Linux：
  ```bash
  cd <工作区目录>
  chmod +x ./install.sh && ./install.sh
  ```
</details>

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
2. 环境变量（修改后需重启 Antigravity 生效）：
   - Windows PowerShell: `$env:PRO_MODE="shadow"`
   - macOS / Linux: `export PRO_MODE=shadow`

---

## 自检诊断与决策复盘

### 1. 自动化自检套件
运行内置的 71 项端到端及单元测试断言：
```bash
node scripts/doctor.mjs
```

### 2. 生产决策复盘
查看最近 7 天在真实会话中触发的守门数据（自动剔除测试生成的数据）：
```bash
node scripts/report.mjs
```

指定统计天数：
```bash
node scripts/report.mjs --days 30
```

---

## 目录结构

```text
pro-flash-orchestrator/
├── plugin.json                 # Antigravity 插件配置清单
├── hooks.json                  # 生命周期钩子路由定义
├── .gitattributes              # 固化 Shell 脚本换行符为 LF
├── LICENSE                     # MIT 开源许可证
├── README.md                   # 英文说明文档
├── README.zh-CN.md             # 中文说明文档
├── install.ps1                 # Windows 快速挂载脚本
├── install.sh                  # macOS/Linux 快速挂载脚本
├── rules/
│   └── AGENTS.md               # 常驻主创与助手职责规范
├── skills/
│   └── flash-dev/
│       └── SKILL.md            # /flash-dev 技能描述与提示词模板
├── scripts/
│   ├── lib.mjs                 # 核心共享库（Payload 解析、子代理识别、路径归一、日志）
│   ├── session-start.mjs       # 会话初始化引导与状态卡片
│   ├── pre-invocation.mjs      # 转录滑动窗口漂移提醒
│   ├── guard-subagent.mjs      # 子代理守门（递归拦截、物理降级、中立契约）
│   ├── guard-read-file.mjs     # 文件读取守门（智能切片、生态豁免）
│   ├── guard-command.mjs       # 命令守门（多层解包、重定向放行、倾倒拦截）
│   ├── doctor.mjs              # 71 项全量自检测试套件
│   └── report.mjs              # 生产决策聚合与统计复盘
└── assets/
    └── logo.svg                # 插件图标
```

---

## 开源许可证

本项目基于 [MIT 许可证](LICENSE) 发布。
