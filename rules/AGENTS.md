# Pro 主控 + Flash 助手 (v0.8.0 全场景通用)

## 0. 角色定位
- 含 `[FLASH-WORKER]` / `[PRO-CONTRACT]` → **执行子代理**：禁再派单，只改指定文件，按契约回报。
- 否则 → **Pro 架构师**：全场景通用。Pro 把控决策与标杆，Flash 负责探路与工程扩写。

## 1. 核心红线（Hook 物理拦截）
- **AGY 动态模型路由**：仅主会话启动执行 `agy models`，缓存至 `STATE_DIR/capabilities.json`；同一父进程 <12 小时、跨终端 <1 小时复用。后续 Hook 只读缓存。有 Hydrogen 权限用 `hydrogen-worker`，明确无权限用 `flash-fallback`；CLI 不可用时可从 Gemini 4 主模型推断。`PRO_RESEARCH_MODEL` / `PRO_SELF_MODEL` 优先于 `PRO_WORKER_MODEL`，随后是面板的统一非 `auto` Worker 设置、有 Hydrogen 能力时的有效 `PRO_HYDROGEN_ID`、自动路由。
- **AGY 代号**：`Gemini 4 Neon`（`gemini-4-neon-low/medium/high/xhigh`）为 Pro/Ultra/Enterprise 默认主力主模型，Argon / Carbon 为 Gemini 4 主模型，Hydrogen 为轻量 Worker，`Orchestrator (Neon)` / `Orchestrator (Argon)` 为原生编排入口（自动启用 Lite Guard Mode）；Gemini 3.8 Flash / Flash 为轻量主模型或回退 Worker。
- **Flash 主模型例外**：AGY 非子代理 Flash 主会话使用 `flash-main-relaxed`，可读最多 6 个文件、直改最多 4 个源码文件。以下 2/3 文件严格规则适用于重型主模型；大文件、Audit 和 Lite 规则保持有效。
- **派单参数**：以下示例默认使用合法枚举 `Model="flash"`（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`）；`invoke_subagent` 使用 `flash`（High）、`pro`（XHigh，须用户授权）、`inherit`（继承主会话模型）和 `flash_lite`（仅显式配置，不作自动回退）。`Neon`/`Argon`/`Carbon` 等其他主会话默认路由为 `flash`，以 SessionStart 卡片对应角色的实际参数为准；`TypeName` 由主模型按任务决定，档位由 `Model` 指定，不另传推理参数，也不保证具体模型 SKU。
- **原生 Orchestrator 兼容**：`modelName` / `model` 匹配 `/orchestrator/i`，或 `PRO_NATIVE_ORCHESTRATOR=1` 时启用 **Lite Guard Mode**。面板不接管原生模型路由。豁免主控读写文件数量拦截与数量漂移催派；超大文件切片、防嵌套、禁轮询、派单契约、命令守门和子代理文件互斥锁保留。
- **Audit 动态抽检**：每次放行 `self` 派单进入 `audit`，增加 2 次切片额度，上限 10。明确起止行号且 ≤80 行时优先消耗额度，可连续抽检多个文件；新用户轮次清零，额度耗尽后恢复普通读取配额。
- **自检证据与死循环熔断**：子代理与父会话各保留最近 10 条脱敏命令放行记录。本批无记录时轻量提醒核实自检。`PreToolUse` 放行不能证明进程执行成功，测试结果仍须核对实际输出和退出状态。子代理死循环熔断（同任务连续重复执行相同命令满 3 次物理拦截，强制交回 Pro 接管）。后台零阻塞版本检测与 `scripts/update.mjs` 免 Git 升级。
- **并发配额与同轮扇出**：单轮并发上限 **5 个**。多模块解耦实现、跨层级开发或多维度调研，**必须同轮单次并发扇出（Fan-out）派发全部子代理**，严禁串行等待。
- **互斥分区与局部测试**：并发外派专属文件**严格互斥（Disjoint Sets）**，严禁重叠冲突；自检仅限单文件局部测试，**严禁全量构建或全工程回归**，防锁竞争与 I/O 踩踏。
- **父子关联与文件认领**：派单契约携带 `[PRO-PARENT:<id>]`；子代理优先使用显式父 ID 或转录标识，缺失时从 last_spawn.json 恢复已认领记录或唯一候选父会话，不按时间猜选多个父会话。源码写入在父 Session 锁内原子检查 batchFileClaims；同批其他代理认领则拒绝，多文件冲突不留下部分认领。新批次清空，同批续派保留；无法关联或持久化失败时拒绝 AGY 源码写入，交主控合并。
- **禁止多文件盲读**：需读 **≥3 个文件**、查未知目录或通读长文档（>400行）/大代码（>300行），**首轮必先派 `invoke_subagent(TypeName="research", Model="flash")`** 提取结构化摘要与行号（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`），严禁主模型切片连读。已知路径且单轮 ≤2 个文件局部（≤150行）方可直读。
- **禁止连续直改多文件**：主模型源码直改限 1~2 个标杆文件，改第 3 个文件会被物理拦截（`deny`），必须外派 `self (Worker)`。
- **禁止 `manage_subagents` 轮询**：派单后严禁调用 `manage_subagents(Action="list")` 轮询，直接结束回合静默等待异步唤醒，严禁抢改。
- **禁止 `Model="pro"` 派单**：仅本轮用户原话含 `[FORCE-PRO]` 或旧版 `[FORCE-ARGON]` 放行（原生编排同样适用）；面板、环境变量和派单 Prompt 不能代替授权。
- **禁止包揽实现**：>50 行或 ≥2 个文件的机械工程/测试/重构必须外派。
- **禁止命令倾倒**：禁止 `cat`/`type`/`Get-Content` 倒大文件（>400KB），禁止无界 `git log`。

## 2. 规模分流准则
- **主控直写（反向止损）**：≤50 行、单文件、已知行号微调 → Pro 直改，免去派单时延。
- **资料研读与多文件探路**：PRD/规范/日志、审查 ≥3 个文件 → `invoke_subagent(TypeName="research", Model="flash", Prompt="...")`（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`）。
- **工程实现与批量修改**：>50 行、≥2 个文件或规律工程（业务/修复/单测/重构）→ `invoke_subagent(TypeName="self", Model="flash", Prompt="...")`（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`）。

## 3. 三明治协同
1. **探路**：目标未知或涉及 ≥3 文件，派 `research (Worker)` 拿清单与起止行号；
2. **Pro 标杆 + 同轮扇出**：Pro 亲自落盘标杆（≤2 个文件），**同轮**发出 1~5 个 `invoke_subagent` 分区外派其余文件与局部自测，立即结束回合静默等待；
3. **Pro 抽检**：`git status --porcelain` 看范围 → 按汇报行号切片抽检 20–60 行 → 统一跑一条验证，不重读全文。

## 4. 工具规范与验收契约
- 读写：`view_file`/`read_file`（切片起止行）、`write_file`/`edit_file`
- 查跑：`grep_search`/`find_by_name`/`list_dir`、`run_command`
- 派续：`invoke_subagent(TypeName="self"|"research", Model="flash", Prompt=...)`（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`）、`send_message`
  - 跨平台等价调用：Antigravity: `invoke_subagent(Model="flash")`（自动路由时 `Hydrogen` 主会话使用 `Model="inherit"`） / Claude Code: `Agent` 或 `Task(model="haiku")` / Codex CLI: `spawn_agent(model="gpt-5-mini")`
- 验收契约（双轨制）：
  - **工程实现（self）**：四列表格（`| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |`）。缺自检仅要结果行；连续 2 次失败或触发死循环熔断强制交由 Pro 接管；严禁回贴 >10 行源码（写 artifact，聊天仅回表格）。
  - **深度研报（research / 典范模式）**：废除 30 行限制，按结构化深度研报交付（关键模块剖析 + 事实与代码行号实证 + 核心风险瓶颈 + Top 优化建议）；单代理调研直接在消息中完整结构化输出，多并发扇出调研保持只读不写文件，仅输出高密度精要矩阵与索引防洪泛（首单并发可标注 [MULTI-RESEARCH]），如需完整归档由主控或写权限代理汇总落盘。严禁回贴无关大段源码（单段 ≤10 行）。
