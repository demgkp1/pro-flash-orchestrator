# Pro Architect + Flash Worker (`pro-flash-orchestrator` v3.3.0)

面向 Antigravity 的高能效双级分流插件：**Pro 做架构与把关，Flash 做工程扩写与自检**。

v3.3 把所有靠提示词自觉履行的要求下移到 Hook 物理守门，杜绝大模型偷懒漏网、大文件撑爆上下文、命令泄洪刷屏与跨平台兼容死角。

---

## 核心机制全景 (v3.3)

| 能力 | 守门机制 | 核心逻辑与文件 |
| :--- | :--- | :--- |
| **角色注入与状态卡片** | `SessionStart` | 一次性写入持久 `systemMessage`；状态卡片走 `renderInfo`（只给 UI 渲染，模型零消耗）。(`scripts/session-start.mjs`) |
| **`pro` 物理降级** | `PreToolUse` (subagent) | 派单时 `Model` 缺失 / `inherit` / `pro` 自动降级为 `flash`（普通扩写）或 `flash_lite`（调研）；`[FORCE-PRO]` 或旧版 `[FORCE-ARGON]` 可豁免；容错双重引号序列化。(`scripts/guard-subagent.mjs`) |
| **递归防套娃** | `PreToolUse` (subagent) | 子代理三级判定（`parentConversationId` → 转录首行 `SYSTEM` 判定 → `[FLASH-WORKER]` 前缀）；子代理尝试派单直接 `deny` 阻断。(`scripts/guard-subagent.mjs` + `scripts/lib.mjs`) |
| **中立契约注入** | `PreToolUse` (subagent) | 派单自动注入 `[PRO-CONTRACT]`；工程代理要求四列表格报告与测试自检证据；调研代理（`research`）自动切换为只读消息摘要模式，不要求写 artifact；`send_message` 追加中立契约。(`scripts/guard-subagent.mjs`) |
| **大文件智能切片** | `PreToolUse` (read_file) | 代码 >300 行平滑 `overwrite` 切片为 150 行（零额外交互轮次）；代码 >800 行或文档 >400 行才 `deny` 改派 `flash_lite`；Python `venv`/`.venv` 与 Rust `target` 等依赖构建产物自动豁免。(`scripts/guard-read-file.mjs`) |
| **命令防倾倒与重定向放行** | `PreToolUse` (run_command) | 多层 Shell 解包（覆盖 PowerShell/cmd/bash/zsh/sh/wsl）；拦截 >400KB 大文件的无界倾倒（`cat`/`type`/`Get-Content`）与无界 `git log`；放行输出重定向（`>`、`>>`、`| Set-Content`、`| Out-Null`、`> /dev/null`、`> $null`、`> NUL`）。(`scripts/guard-command.mjs`) |
| **会话漂移感知** | `PreInvocation` | 平时保持静默；基于转录滑动窗口，**自上次派单以来**连续 4 次直接改文件时注入单轮即抛的 `ephemeralMessage` 提醒分流。(`scripts/pre-invocation.mjs`) |
| **自动化自检** | `doctor.mjs` | **52 项断言**覆盖环境、所有 Hook 边界、跨平台兼容性与安全豁免。(`scripts/doctor.mjs`) |
| **决策复盘** | `report.mjs` | 排除自检后的真实生产决策数据统计，用于科学调优阈值。(`scripts/report.mjs`) |

---

## 快速安装与配置

### Windows (PowerShell)
```powershell
# 1. 克隆到本地任意目录（例如 D:\tools 或 ~/tools）
git clone https://github.com/demgkp1/pro-flash-orchestrator.git D:\tools\pro-flash-orchestrator
cd D:\tools\pro-flash-orchestrator

# 2. 运行安装脚本（建立目录联接挂载到 Antigravity，无需管理员权限）
.\install.ps1
```

### macOS / Linux (bash / zsh)
```bash
# 1. 克隆到本地任意目录
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/tools/pro-flash-orchestrator
cd ~/tools/pro-flash-orchestrator

# 2. 运行安装脚本（建立符号链接挂载到 Antigravity）
chmod +x ./install.sh && ./install.sh
```

安装脚本仅创建指向仓库的 Junction / Symlink，不拷贝冗余文件；后续 `git pull` 即可无缝升级。

### 运行环境与自检
```bash
# 执行 52 项自检
node scripts/doctor.mjs

# 查看历史真实决策复盘（排除自检）
node scripts/report.mjs
```

---

## 运行模式与调优

| 模式 | 行为 | 适用场景 |
| :--- | :--- | :--- |
| `enforce`（默认） | 所有物理守门生效 | 生产标准环境 |
| `shadow` | 仅记录决策日志，不实施修改与拦截 | 首次接入试运行观测 |
| `off` | 全部关闭，完全放行 | 紧急绕过开关 |

### 模式切换
- **环境变量**（当前终端）：`$env:PRO_MODE="shadow"`（或 `export PRO_MODE=shadow`）
- **持久化配置**：`.state/mode.json` 写入 `{"mode":"shadow"}`（优先级低于环境变量）

---

## 项目目录结构

```text
pro-flash-orchestrator/
├── plugin.json                 # 插件元数据（Antigravity 识别 entry）
├── hooks.json                  # 生命周期钩子匹配与调用路由
├── README.md                   # 插件使用与架构说明文档
├── install.ps1                 # Windows 目录联接安装脚本
├── install.sh                  # macOS/Linux 符号链接安装脚本 (LF)
├── rules/
│   └── AGENTS.md               # 常驻主创与助手职责规范
├── skills/
│   └── flash-dev/
│       └── SKILL.md            # /flash-dev 派单提示词与工程模板
├── scripts/
│   ├── lib.mjs                 # 核心共享库（解析、会话判定、路径处理、日志）
│   ├── session-start.mjs       # 会话启动软引导与状态卡片
│   ├── pre-invocation.mjs      # 转录滑动窗口漂移提醒
│   ├── guard-subagent.mjs      # 子代理守门（递归拦截、降级、中立契约）
│   ├── guard-read-file.mjs     # 文件读取守门（智能切片、生态豁免）
│   ├── guard-command.mjs       # 命令守门（解包、重定向放行、倾倒拦截）
│   ├── doctor.mjs              # 52 项全覆盖自检套件
│   └── report.mjs              # 生产决策聚合与统计复盘
└── assets/
    └── logo.svg                # 插件图标
```

---

## 版本变更日志

- **3.3.0**：
  - 正式将概念与配置正名为 `pro-flash-orchestrator`（全面对齐 Gemini/Antigravity 官方 Pro/Flash 命名体系）；
  - 命令守门深度优化：识别文件输出重定向与黑洞重定向（`>`、`>>`、`| Set-Content`、`| Out-Null`、`> /dev/null`、`> $null`、`> NUL`），消除误拦截；
  - 契约注入中立化：`send_message` 追加中立契约，`research` 代理直出结构化报告，不强迫写 artifact 文件；
  - 现代生态豁免扩充：对 Python（`venv`、`.venv`、`.tox`）与 Rust（`target`）等依赖与构建目录实施豁免；
  - 跨平台兼容增强：`install.sh` 固化 LF，多层 Shell 解包全面覆盖 Windows cmd/PowerShell 与 POSIX bash/zsh/sh；
  - 自检用例全面重构扩充至 52 项通过。
- **3.2.1**：
  - 修复 `SessionStart` 因 `metadata.user_markdown` 导致的适配器 panic（改用 `renderInfo`）；
  - 子代理识别优先采用转录首行 `SYSTEM` 判定；双重编码 Model 容错；新增 `report.mjs`。
- **3.2.0**：
  - 物理守门体系建立：自动降级、递归阻断、大文件智能切片、命令倾倒拦截与漂移检测。
