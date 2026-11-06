# Pro-Flash Orchestrator

面向 Google Antigravity 的双级大模型协同分流引擎。

由 Pro 模型负责高维度系统架构、核心接口与算法设计；Flash 及 Flash-Lite 模型负责外围工程扩写、测试用例编写与文档检索。所有分流策略均下沉至底层生命周期 Hook 进行物理拦截，杜绝上下文膨胀与配额损耗。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v3.3.0-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%202.0-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Tests-63%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 设计背景

在大模型辅助软件工程中，依赖旗舰模型（Pro）完成全部任务通常会导致两类不可逆的损耗：

1. 经济与配额损耗：旗舰模型在处理机械化 CRUD、数据转换、批量单测编写等工程体力活时，消耗了高昂的高级配额。
2. 上下文退化：当模型无界倾倒大文件（如直接 `cat` 或通读超大代码与日志）时，上下文窗口迅速被噪声填满，导致后续逻辑推理能力下降。

单纯在 System Prompt 中加入软性提示（例如“请外派子代理”）在长程交互中极易因模型注意力漂移而失效。Pro-Flash Orchestrator 采用 Antigravity 原生生命周期 Hook，在工具执行前（PreToolUse）、模型调用前（PreInvocation）及会话初始化（SessionStart）施加确定性的物理校验与自动化改写。

---

## 协同分工模型

```text
[ 用户输入 / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│         Pro 主创架构师 (旗舰模型)       │
│  - 领域设计 / 数据库 Schema / 核心算法 │
│  - 编写核心标杆文件 (Benchmark)         │
│  - 同轮并发派发子代理                  │
└───────────────────┬────────────────────┘
                    │ invoke_subagent
                    ▼
┌────────────────────────────────────────┐
│       Hook 守门拦截 (Physical Guards)  │
│  - 物理强制降级: Pro -> Flash/Flash-Lite│
│  - 自动追加 [PRO-CONTRACT] 汇报契约   │
│  - 递归阻断: 禁止子代理再次派单        │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│         Flash 执行助手 (轻量模型)      │
│  - 机械实现 / CRUD / 单元测试 / 迁移   │
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
| **角色与契约初始化** | `SessionStart` | 会话启动时单次注入规则说明；状态卡片通过 `renderInfo` 投递至 UI 渲染层。 | 状态卡片对大模型零 Token 消耗，不侵占上下文。 |
| **子代理物理降级** | `PreToolUse` (`invoke_subagent`) | 检查请求模型，若为 `pro` 且未携带 `[FORCE-PRO]` 豁免标识，强制改写为 `flash`（开发任务）或 `flash_lite`（调研任务）。 | 杜绝体力活外派占用 Pro 配额。 |
| **递归派单阻断** | `PreToolUse` (`invoke_subagent`, `define_subagent`) | 通过转录首行 `SYSTEM`/`SYSTEM_SDK` 及上下文特征识别子代理身份，拦截子代理再次派单（`deny`）。 | 消除无休止的多层子代理调用死循环。 |
| **中立契约注入** | `PreToolUse` (`invoke_subagent`, `send_message`) | 派单时自动追加 `[PRO-CONTRACT]`：工程任务必须返回四列表格并附带自检结果；调研任务（`research`）必须直接输出结构化摘要，不要求写文件。 | 消除大段源码回贴与只读沙箱写文件异常。 |
| **大文件智能切片** | `PreToolUse` (`read_file`, `view_file`) | 未显式切片读取代码文件（300-800行）时，自动改写参数限制在 [1, 150] 行内；超过 800 行代码或 400 行文档/数据日志直接拦截，引导使用子代理。豁免 `.venv` 与 `target` 等依赖目录。 | 消除超大文件撑爆上下文的隐患，小文件切片无需额外轮次。 |
| **命令防倾倒** | `PreToolUse` (`run_command`) | 多层递归解包 Shell 命令；按顶层管道切分判定；拦截未分页的 `git log` 与针对 >400KB 文件的无界 `cat`/`Get-Content`。放行输出重定向（`>`、`>>`、`| Set-Content`、`> /dev/null`）。 | 杜绝终端海量日志倾倒至对话中，同时不影响离线写盘操作。 |
| **会话漂移感知** | `PreInvocation` | 解析转录滑动窗口，自上次派单以来若连续 4 次直接改动代码文件且未派单，注入单轮即抛的 `ephemeralMessage` 提醒分流。 | 保持静默，仅在出现注意力漂移时发出无上下文残留的即时告警。 |

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
运行内置的 63 项端到端及单元测试断言：
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
│   ├── doctor.mjs              # 63 项全量自检测试套件
│   └── report.mjs              # 生产决策聚合与统计复盘
└── assets/
    └── logo.svg                # 插件图标
```

---

## 开源许可证

本项目基于 [MIT 许可证](LICENSE) 发布。
